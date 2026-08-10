#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * Eval harness.
 *
 *   npm run eval:offline   deterministic guardrails — no API key, no server
 *   npm run eval           the above, plus end-to-end cases against the model
 *
 * The offline suite is the more load-bearing of the two. It asserts that the
 * routing guarantees hold as a property of the code rather than as observed
 * model behaviour on a sample — a dispute-shaped classification cannot reach
 * the answer path, whatever the model does.
 * ------------------------------------------------------------------------- */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDom } from "./dom.js";
import {
  makeContext,
  authorizeInvoice,
  decidePreAnswer,
  decidePostAnswer,
  inWindowInvoices,
  uncitedFigures,
  payerVisible,
  offersPayment,
  paymentIsPrimary,
  MERCHANT_INTERNAL_FIELDS,
} from "../lib/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const dataset = JSON.parse(
  fs.readFileSync(path.join(root, "data", "synthetic_invoice_data.json"), "utf8"),
);
const cases = JSON.parse(fs.readFileSync(path.join(here, "cases.json"), "utf8"));
const ctx = makeContext(dataset);

const ONLINE = !process.argv.includes("--offline");
const BASE = process.env.EVAL_BASE_URL ?? "http://localhost:3000";

/* The server refuses an identical handoff twice (AC14), which is correct
   behaviour and would otherwise make the suite fail on its second run inside
   the dedupe window. Each run stamps its messages so they are genuinely
   distinct, exactly as two real messages would be. */
const RUN = Date.now().toString(36);
const stamp = (payload) =>
  payload.message
    ? { ...payload, message: `${payload.message} [run ${RUN}]` }
    : payload;

/* Every response state public/app.js can render, from its LABELS map. The two
   payment rules are duplicated into the browser bundle; OFF-20 compares the
   copies across all of these. */
const UI_STATES = [
  "answer", "cannot_answer", "no_history", "dispute", "out_of_scope",
  "contact_request", "not_a_question", "not_found", "error", "config", "invalid",
];

/* Lift the browser's copies of the two AC13 rules out of public/app.js and
   make them callable here. They are plain functions over plain data with no
   DOM access, so they run unchanged outside a page. */
function browserPaymentRules() {
  const src = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const offers = src.match(/function offersPayment\([\s\S]*?\n}/);
  const primary = src.match(/const paymentIsPrimary = [^;]+;/);
  if (!offers || !primary) {
    throw new Error("could not find the payment rules in public/app.js");
  }
  return new Function(
    `${offers[0]}\n${primary[0]}\nreturn { offersPayment, paymentIsPrimary };`,
  )();
}

/* The intents the classifier can return, read out of server.js rather than
   restated here, so removing or adding one cannot leave this suite testing a
   label that no longer exists. */
const CLASSIFIER_INTENTS = (() => {
  const src = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const m = src.match(/enum:\s*\[([^\]]+)\]/);
  if (!m) throw new Error("could not find the classifier enum in server.js");
  return m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
})();

const results = [];
function record(id, ac, name, ok, detail = "") {
  results.push({ id, ac, name, ok, detail });
}

/* --- offline suite -------------------------------------------------------- */

function runOffline() {
  for (const c of cases.offline) {
    try {
      /* Invoice notes are retrieved and shown to the customer, so anything
         written there for the benefit of a test author is a leak. This caught
         a note instructing the reader that a dispute "routes to human
         support", which the model duly reported to the customer as fact,
         describing behaviour the system no longer has. */
      // Retrieval is bounded by entitlement, not only by date. Every path that
      // returns records must strip the merchant's own annotations.
      /* AC13 across every combination of invoice status and response state.
         The disputed case is the one that matters: a Pay button under a
         contested charge reads as the merchant pressing for money. */
      if (c.paymentOffer) {
        const expected = [
          // an invoice flagged as contested: never, whatever was asked. It is
          // still outstanding; the contest is a flag beside the status.
          ["INV-1085", "answer", false, null],
          ["INV-1085", "cannot_answer", false, null],
          ["INV-1085", "dispute", false, null],
          // an ordinary unpaid invoice: always offered, but it leads only where
          // the question was answered, because that is where paying settles the
          // matter. After a decline or a complaint the route to a person leads.
          ["INV-1071", "answer", true, true],
          ["INV-1071", "cannot_answer", true, false],
          ["INV-1071", "no_history", true, false],
          ["INV-1071", "dispute", true, false],
          ["INV-1071", "contact_request", true, false],
          // nothing was asked: paying is the only way forward offered, since
          // forwarding an insult or a greeting to the merchant is not one
          ["INV-1071", "not_a_question", true, false],
          ["INV-1085", "not_a_question", false, null],
          // settled: nothing to pay
          ["INV-1058", "answer", false, null],
        ];
        const wrong = [];
        for (const [id, state, want, primary] of expected) {
          const inv = dataset.invoices.find((i) => i.invoice_id === id);
          const got = offersPayment(inv, state);
          if (got !== want) wrong.push(`${id}+${state}: offered ${got}, wanted ${want}`);
          else if (want && paymentIsPrimary(state) !== primary)
            wrong.push(`${id}+${state}: primary ${paymentIsPrimary(state)}, wanted ${primary}`);
        }

        /* The browser has its own copy of both rules, because public/ is plain
           script and cannot import from lib/. A copy that drifts from the
           original is worse than no rule at all, so compare the two directly
           over every invoice and every state the UI can render. */
        const browser = browserPaymentRules();
        for (const inv of dataset.invoices) {
          for (const state of UI_STATES) {
            if (browser.offersPayment(inv, state) !== offersPayment(inv, state)) {
              wrong.push(`app.js disagrees: ${inv.invoice_id}+${state}`);
            }
            if (browser.paymentIsPrimary(state) !== paymentIsPrimary(state)) {
              wrong.push(`app.js disagrees on primary: ${state}`);
            }
          }
        }
        record(c.id, c.ac, c.name, wrong.length === 0, wrong.join("; "));
        continue;
      }

      if (c.entitlement) {
        const leaks = [];
        for (const set of [
          inWindowInvoices(ctx),
          [authorizeInvoice(ctx, "INV-1085").invoice].filter(Boolean),
        ]) {
          for (const inv of set) {
            for (const f of MERCHANT_INTERNAL_FIELDS) {
              if (f in inv) leaks.push(`${inv.invoice_id}.${f}`);
            }
          }
        }
        record(c.id, c.ac, c.name, leaks.length === 0, leaks.join(", "));
        continue;
      }

      if (c.fixtureHygiene) {
        const banned = [
          "should not be answered", "routes to", "retrieval window",
          "query_time", "the system should", "testable", "fixture",
          "acceptance criterion", "for testing",
        ];
        const leaks = [];
        for (const inv of dataset.invoices) {
          const note = (inv.note ?? "").toLowerCase();
          for (const phrase of banned) {
            if (note.includes(phrase)) leaks.push(`${inv.invoice_id}: "${phrase}"`);
          }
          // Retrieval must never hand a merchant annotation to the model.
          const visible = payerVisible(inv);
          for (const f of MERCHANT_INTERNAL_FIELDS) {
            if (f in visible) leaks.push(`${inv.invoice_id}: ${f} survived retrieval`);
          }
        }
        record(c.id, c.ac, c.name, leaks.length === 0, leaks.join("; "));
        continue;
      }

      /* AC7 puts the invoice always in view, so there is nothing to
         disambiguate and no state that should ever ask. Asserted as a property
         over every intent the classifier can return, against an open invoice
         and against none. */
      if (c.noClarifyState) {
        const wrong = [];
        for (const intent of CLASSIFIER_INTENTS) {
          for (const sel of [dataset.invoices.find((i) => i.invoice_id === "INV-1042"), null]) {
            const out = decidePreAnswer(
              ctx,
              { intent, referenced_invoice_ids: [], implies_older_history: false, needs_history: false },
              sel,
            );
            const state = out.terminal?.state;
            if (state && /clarify|ambigu|pick/i.test(state)) {
              wrong.push(`${intent}: ${state}`);
            }
            if (out.terminal?.candidates) wrong.push(`${intent}: returned candidates`);
          }
        }
        record(c.id, c.ac, c.name, wrong.length === 0, wrong.join("; "));
        continue;
      }

      /* Merchant names routinely end in a full stop ("Ferro Supply Co."), so any
         message interpolating one and continuing with its own punctuation
         produces "Co..". Assert over every terminal message rather than relying
         on whoever writes the next one to remember. */
      if (c.copyHygiene) {
        const intents = CLASSIFIER_INTENTS.map((intent) => ({
          intent, referenced_invoice_ids: [], implies_older_history: false, needs_history: false,
        }));
        const selected = dataset.invoices.find((i) => i.invoice_id === "INV-1071");
        const messages = [];
        for (const intent of intents) {
          for (const sel of [selected, null]) {
            const t = decidePreAnswer(ctx, intent, sel).terminal;
            if (t?.message) messages.push([`${intent.intent}`, t.message]);
          }
        }
        for (const status of ["no_supporting_records", "no_comparison_history"]) {
          const out = decidePostAnswer(ctx, intents[0], { status, answer: "x", citations: [] });
          if (out.message) messages.push([status, out.message]);
        }
        const bad = [];
        for (const [where, m] of messages) {
          if (/\.\./.test(m)) bad.push(`${where}: doubled full stop`);
          if (/\s{2,}/.test(m)) bad.push(`${where}: doubled space`);
          if (/\s+[.,]/.test(m)) bad.push(`${where}: space before punctuation`);
        }
        record(c.id, c.ac, c.name, bad.length === 0, [...new Set(bad)].join("; "));
        continue;
      }

      // AC6 — authorization cases
      if (c.authorize !== undefined) {
        const auth = authorizeInvoice(ctx, c.authorize);
        const ok = auth.ok === c.expect.authorized;
        record(c.id, c.ac, c.name, ok, ok ? "" : `ok=${auth.ok}, wanted ${c.expect.authorized}`);
        continue;
      }

      // AC1 — groundedness cases
      if (c.groundedness) {
        const got = uncitedFigures(c.groundedness.answer, c.groundedness.citations);
        const want = c.expect.uncited;
        const ok = got.length === want.length && got.every((v, i) => v === want[i]);
        record(c.id, c.ac, c.name, ok, ok ? "" : `uncited=[${got}], wanted [${want}]`);
        continue;
      }

      // Stage-2 cases — supply a model result, assert the mapped state
      if (c.result) {
        const out = decidePostAnswer(ctx, c.intent, c.result);
        let ok = out.state === c.expect.state;
        let detail = ok ? "" : `state=${out.state}, wanted ${c.expect.state}`;

        if (ok && c.expect.hasNotice === true && !out.notice) {
          ok = false;
          detail = "expected an older-history notice, got none";
        }
        if (ok && c.expect.hasNotice === false && out.notice) {
          ok = false;
          detail = "unexpected older-history notice";
        }
        if (ok && c.expect.noRetry && out.retry) {
          ok = false;
          detail = "a decline must not offer retry";
        }
        record(c.id, c.ac, c.name, ok, detail);
        continue;
      }

      // Stage-1 cases — supply a classification, assert the routing
      const selected = c.selected
        ? dataset.invoices.find((i) => i.invoice_id === c.selected)
        : null;
      const pre = decidePreAnswer(ctx, c.intent, selected);

      if (c.expect.terminal === false) {
        let ok = !pre.terminal;
        let detail = ok ? "" : `terminated as ${pre.terminal.state}, expected to proceed`;
        if (ok && c.expect.recordsExclude) {
          const ids = pre.records.map((r) => r.invoice_id);
          const leaked = c.expect.recordsExclude.filter((x) => ids.includes(x));
          if (leaked.length) {
            ok = false;
            detail = `out-of-window record(s) retrieved: ${leaked}`;
          }
        }
        record(c.id, c.ac, c.name, ok, detail);
        continue;
      }

      let ok = Boolean(pre.terminal) && pre.terminal.state === c.expect.state;
      let detail = ok
        ? ""
        : `state=${pre.terminal ? pre.terminal.state : "proceeded"}, wanted ${c.expect.state}`;

      if (ok && c.expect.minCandidates) {
        const n = pre.terminal.candidates?.length ?? 0;
        if (n < c.expect.minCandidates) {
          ok = false;
          detail = `${n} candidates, wanted ≥${c.expect.minCandidates}`;
        }
      }
      record(c.id, c.ac, c.name, ok, detail);
    } catch (err) {
      record(c.id, c.ac, c.name, false, `threw: ${err.message}`);
    }
  }
}

/* --- online suite --------------------------------------------------------- */

async function runOnline() {
  for (const c of cases.online) {
    try {
      // AC11 — handoff cases hit the routing endpoint, not the Q&A one, and
      // need no model call. The assertion is that a failed forward is never
      // reported as sent.
      // AC14 — the second identical send must be refused.
      if (c.routeTwice) {
        const fire = async () => {
          const r = await fetch(`${BASE}/api/route-to-merchant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(stamp(c.routeTwice)),
          });
          const b = await r.json().catch(() => ({}));
          return r.ok && b.ok === true;
        };
        const first = await fire();
        const second = await fire();
        const ok = first === c.expect.firstOk && second === c.expect.secondOk;
        record(c.id, c.ac, c.name, ok, ok ? "" : `first=${first}, second=${second}`);
        continue;
      }

      if (c.route) {
        const r = await fetch(`${BASE}/api/route-to-merchant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(stamp(c.route)),
        });
        const b = await r.json().catch(() => ({}));
        const confirmed = r.ok && b.ok === true;
        const ok = confirmed === c.expect.routeOk;
        record(
          c.id,
          c.ac,
          c.name,
          ok,
          ok ? "" : `confirmed=${confirmed}, wanted ${c.expect.routeOk}`,
        );
        continue;
      }

      const res = await fetch(`${BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceId: c.invoiceId,
          question: c.question,
          ...(c.simulateFailure ? { simulateFailure: true } : {}),
        }),
      });
      const body = await res.json();

      if (body.state === "config") {
        record(c.id, c.ac, c.name, false, "ANTHROPIC_API_KEY not set on the server");
        continue;
      }

      const allowed = c.expect.stateOneOf ?? [c.expect.state];
      let ok = allowed.includes(body.state);
      let detail = ok ? "" : `state=${body.state}, wanted ${allowed.join(" or ")}`;

      if (ok && c.expect.minCitations) {
        const n = body.citations?.length ?? 0;
        if (n < c.expect.minCitations) {
          ok = false;
          detail = `${n} citations, wanted ≥${c.expect.minCitations}`;
        }
      }

      if (ok && c.expect.minDistinctInvoices) {
        const n = new Set((body.citations ?? []).map((x) => x.invoice_id)).size;
        if (n < c.expect.minDistinctInvoices) {
          ok = false;
          detail = `citations span ${n} invoice(s), wanted ≥${c.expect.minDistinctInvoices}`;
        }
      }

      // AC1's actual claim — every figure in an answer traces to a citation.
      if (ok && c.expect.allFiguresCited && body.state === "answer") {
        const uncited = uncitedFigures(body.answer, body.citations);
        if (uncited.length) {
          ok = false;
          detail = `uncited figure(s) in answer: ${uncited.join(", ")}`;
        }
      }

      /* A marker pointing at nothing is worse than no marker: it looks like
         attribution while providing none. Every [n] must resolve, and no
         figure may be left unmarked. */
      if (ok && c.expect.allFiguresCited && body.state === "answer") {
        const n = (body.citations ?? []).length;
        const markers = [...String(body.answer).matchAll(/\[(\d+)\]/g)].map((m) => +m[1]);
        const dangling = markers.filter((m) => m < 1 || m > n);
        if (dangling.length) {
          ok = false;
          detail = `citation marker(s) resolve to nothing: ${dangling.join(", ")}`;
        } else {
          const figures = String(body.answer).match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? [];
          if (figures.length && markers.length < figures.length) {
            ok = false;
            detail = `${figures.length} figure(s) but ${markers.length} marker(s)`;
          }
        }
      }

      if (ok && c.expect.minCandidates) {
        const n = body.candidates?.length ?? 0;
        if (n < c.expect.minCandidates) {
          ok = false;
          detail = `${n} candidates, wanted ≥${c.expect.minCandidates}`;
        }
      }

      // The handoff must be offered when part of the question is only
      // answerable by the merchant, otherwise the customer is told the system
      // cannot help and given nowhere to go.
      // The model cannot quote what it was never given.
      if (ok && c.expect.answerExcludes) {
        const text = (body.answer ?? body.message ?? "").toLowerCase();
        const found = c.expect.answerExcludes.filter((p) => text.includes(p.toLowerCase()));
        if (found.length) {
          ok = false;
          detail = `answer contains merchant-internal wording: ${found.join(", ")}`;
        }
      }

      // An escape sequence that survived parsing looks like a broken page.
      if (ok && c.expect.noRawEscapes) {
        const text = body.answer ?? body.message ?? "";
        const m = text.match(/\\u[0-9a-fA-F]{4}|\\/);
        if (m) {
          ok = false;
          detail = `stray escape character in answer: ${JSON.stringify(m[0])}`;
        }
      }

      if (ok && c.expect.needsMerchant) {
        const offered = body.state !== "answer" || body.needsMerchant === true;
        if (!offered) {
          ok = false;
          detail = "answered without flagging that the merchant is needed";
        }
      }

      if (ok && c.expect.hasNoticeIfAnswer && body.state === "answer" && !body.notice) {
        ok = false;
        detail = "answer implied pre-window history but carried no disclosure";
      }

      record(c.id, c.ac, c.name, ok, detail);
    } catch (err) {
      record(c.id, c.ac, c.name, false, `request failed: ${err.message}`);
    }
  }
}

/* --- report --------------------------------------------------------------- */

function report() {
  const pad = (s, n) => String(s).padEnd(n);
  const w = Math.min(52, Math.max(...results.map((r) => r.name.length)));

  console.log("");
  for (const r of results) {
    const mark = r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(
      `  ${mark}  ${pad(r.id, 7)} ${pad(r.ac, 20)} ${pad(r.name.slice(0, w), w)}` +
        (r.detail ? `  \x1b[33m${r.detail}\x1b[0m` : ""),
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(`  ${results.length - failed.length}/${results.length} passed`);
  console.log("");
  return failed.length === 0;
}

/* --- main ----------------------------------------------------------------- */

console.log(
  ONLINE
    ? `\n  Eval — offline guardrails + end-to-end against ${BASE}`
    : "\n  Eval — offline guardrails only (no model calls)",
);

runOffline();
await runDom(record); // browser layer, still no server and no key
if (ONLINE) await runOnline();

process.exit(report() ? 0 : 1);
