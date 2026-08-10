/* ---------------------------------------------------------------------------
 * DOM suite — the browser layer, asserted rather than looked at.
 *
 * public/app.js holds the only real session state in the app: what has been
 * sent, what is half-typed, and what was sent a moment ago. Three faults in one
 * afternoon came from combinations of those, each rule correct on its own. The
 * invariants below are taken from evals/state-model.md and are checked across
 * the combinations rather than case by case, because that is where the faults
 * were.
 *
 * No server and no API key: the page is loaded into jsdom and every fetch is
 * answered from the fixture.
 * ------------------------------------------------------------------------- */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { makeContext, inWindowInvoices } from "../lib/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataset = JSON.parse(
  fs.readFileSync(path.join(root, "data", "synthetic_invoice_data.json"), "utf8"),
);
const ctx = makeContext(dataset);

/* Every POST the page attempted, so "nothing is transmitted without a confirm"
   can be asserted rather than assumed. */
let posted = [];
let failRouting = false;

async function boot() {
  posted = [];
  failRouting = false;

  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost:3000/" });
  const { window } = dom;

  // jsdom implements neither, and neither affects what is rendered.
  window.Element.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.focus = () => {};

  window.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url === "/api/invoices") {
      return json({
        merchant: dataset.merchant,
        customer: dataset.customer,
        queryTime: dataset.query_time,
        invoices: inWindowInvoices(ctx),
      });
    }
    if (url === "/api/route-to-merchant") {
      posted.push({ url, body });
      if (failRouting) return json({ ok: false }, 503);
      return json({ ok: true, merchant: dataset.merchant.name });
    }
    posted.push({ url, body });
    return json({ state: "answer", answer: "x", citations: [] });
  };

  const script = window.document.createElement("script");
  script.textContent = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  window.document.body.append(script);

  // load() is async; wait for the table it fills.
  for (let i = 0; i < 50 && !window.document.querySelector(".inv-link"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return window;
}

const json = (obj, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => obj,
});

const run = (w, expr) => w.eval(expr);
const q = (w, sel) => w.document.querySelector(sel);
const qa = (w, sel) => [...w.document.querySelectorAll(sel)];
const settle = () => new Promise((r) => setTimeout(r, 20));

/* Drive the handoff the way a customer does, through the DOM. */
async function sendMessage(w, text) {
  qa(w, ".btn-route").find((b) => b.textContent.includes("Write")).click();
  const box = q(w, ".handoff-box");
  box.value = text;
  box.dispatchEvent(new w.Event("input"));
  qa(w, ".btn-route").find((b) => b.textContent === "Continue").click();
  qa(w, ".btn-route").find((b) => b.textContent === "Send").click();
  await settle();
}

/* --- the cases ------------------------------------------------------------ */

const cases = [];
const check = (id, invariant, name, fn) => cases.push({ id, invariant, name, fn });

check("DOM-01", 1, "The sent record appears exactly once, in every state", async (w) => {
  run(w, "select('INV-1071')");
  run(w, "render({state:'cannot_answer',message:'m'})");
  await sendMessage(w, "first message");

  const counts = {};
  counts.afterSend = qa(w, "summary").length;
  run(w, "render({state:'cannot_answer',message:'m'})");
  counts.askAgain = qa(w, "summary").length;
  run(w, "select('INV-1058')");
  run(w, "select('INV-1071')");
  counts.onReturn = qa(w, "summary").length;
  run(w, "render({state:'cannot_answer',message:'m'})");
  counts.askAfterReturn = qa(w, "summary").length;

  const wrong = Object.entries(counts).filter(([, n]) => n !== 1);
  return wrong.length ? `${JSON.stringify(counts)}` : "";
});

check("DOM-02", 2, "A second message never replaces the first", async (w) => {
  run(w, "select('INV-1071')");
  run(w, "render({state:'cannot_answer',message:'m'})");
  await sendMessage(w, "first message");
  run(w, "render({state:'cannot_answer',message:'m'})");
  await sendMessage(w, "second message");
  run(w, "select('INV-1058')");
  run(w, "select('INV-1071')");
  const shown = qa(w, ".detail-sent .sent-message").map((n) => n.textContent);
  if (shown.length !== 2) return `${shown.length} messages shown, wanted 2`;
  if (!shown[0].includes("first")) return `oldest is not first: ${shown[0]}`;
  return "";
});

check("DOM-03", 3, "A response never survives a move to another invoice", async (w) => {
  run(w, "select('INV-1071')");
  run(w, "render({state:'answer',answer:'about 1071',citations:[]})");
  if (!q(w, ".result")) return "no response rendered to begin with";
  run(w, "select('INV-1042')");
  if (q(w, ".result")) return "a response about INV-1071 is showing under INV-1042";
  run(w, "select(null)");
  return q(w, ".result") ? "a response survived closing the invoice" : "";
});

check("DOM-04", 4, "A typed question survives navigating away and back", async (w) => {
  run(w, "select('INV-1071')");
  const input = q(w, ".ask-form input");
  input.value = "why is the freight higher?";
  input.dispatchEvent(new w.Event("input"));
  run(w, "select('INV-1058')");
  run(w, "select('INV-1071')");
  const got = q(w, ".ask-form input").value;
  return got === "why is the freight higher?" ? "" : `box holds "${got}"`;
});

check("DOM-05", 4, "An unsent message survives navigating away and back", async (w) => {
  run(w, "select('INV-1071')");
  run(w, "render({state:'cannot_answer',message:'m'})");
  qa(w, ".btn-route").find((b) => b.textContent.includes("Write")).click();
  const box = q(w, ".handoff-box");
  box.value = "half-written message";
  box.dispatchEvent(new w.Event("input"));
  run(w, "select('INV-1058')");
  run(w, "select('INV-1071')");
  if (!q(w, ".draft-resume")) return "no offer to resume the unsent message";
  q(w, ".draft-resume .btn-route").click();
  const got = q(w, ".handoff-box")?.value;
  return got === "half-written message" ? "" : `resumed with "${got}"`;
});

check("DOM-06", 4, "Sending a message does not discard a typed question", async (w) => {
  run(w, "select('INV-1071')");
  const input = q(w, ".ask-form input");
  input.value = "still want to ask this";
  input.dispatchEvent(new w.Event("input"));
  run(w, "render({state:'cannot_answer',message:'m'})");
  await sendMessage(w, "a message to the merchant");
  run(w, "select('INV-1058')");
  run(w, "select('INV-1071')");
  const got = q(w, ".ask-form input").value;
  return got === "still want to ask this" ? "" : `question lost; box holds "${got}"`;
});

check("DOM-07", 5, "Nothing is transmitted before the confirm step", async (w) => {
  run(w, "select('INV-1071')");
  run(w, "render({state:'cannot_answer',message:'m'})");
  qa(w, ".btn-route").find((b) => b.textContent.includes("Write")).click();
  const box = q(w, ".handoff-box");
  box.value = "something I might regret";
  box.dispatchEvent(new w.Event("input"));
  qa(w, ".btn-route").find((b) => b.textContent === "Continue").click();
  const before = posted.filter((p) => p.url === "/api/route-to-merchant").length;
  if (before !== 0) return `${before} sends before confirming`;
  // and cancelling from the confirm step sends nothing either
  qa(w, ".btn-route").find((b) => b.textContent === "Back").click();
  await settle();
  const after = posted.filter((p) => p.url === "/api/route-to-merchant").length;
  return after === 0 ? "" : `${after} sends after cancelling`;
});

check("DOM-08", 5, "A failed send is never confirmed", async (w) => {
  run(w, "select('INV-1071')");
  run(w, "render({state:'cannot_answer',message:'m'})");
  failRouting = true;
  await sendMessage(w, "this one fails");
  if (q(w, ".routed")) return "a confirmation was shown for a failed send";
  const status = q(w, ".handoff-status")?.textContent ?? "";
  return status.toLowerCase().includes("didn't send") ? "" : `status read "${status}"`;
});

check("DOM-09", 6, "Payment and routing match the state model, in order", async (w) => {
  const model = [
    // invoice, state, pay, route, payLeads
    ["INV-1071", "answer", true, false, true],
    ["INV-1071", "cannot_answer", true, true, false],
    ["INV-1071", "no_history", true, true, false],
    ["INV-1071", "dispute", true, true, false],
    ["INV-1071", "contact_request", true, true, false],
    ["INV-1071", "not_a_question", true, false, true],
    ["INV-1071", "out_of_scope", false, false, null],
    ["INV-1071", "not_found", false, false, null],
    ["INV-1085", "answer", false, false, null], // contested
    ["INV-1085", "dispute", false, true, null], // contested, still routes
    ["INV-1058", "answer", false, false, null], // paid
  ];
  const wrong = [];
  for (const [inv, state, wantPay, wantRoute, wantPayLeads] of model) {
    run(w, `select('${inv}')`);
    run(w, `render({state:'${state}',message:'m',answer:'a',citations:[]})`);
    const box = q(w, ".result");
    const kids = [...box.children];
    const payIdx = kids.findIndex((c) => c.querySelector(".btn-pay-now"));
    const routeIdx = kids.findIndex((c) => c.classList.contains("handoff"));
    const pay = payIdx !== -1;
    const route = routeIdx !== -1;
    if (pay !== wantPay) wrong.push(`${inv}/${state}: pay=${pay}`);
    if (route !== wantRoute) wrong.push(`${inv}/${state}: route=${route}`);
    if (pay && route && wantPayLeads !== null && payIdx < routeIdx !== wantPayLeads) {
      wrong.push(`${inv}/${state}: order wrong`);
    }
  }
  return wrong.join("; ");
});

check("DOM-10", 7, "Retry appears only on an operational failure", async (w) => {
  run(w, "select('INV-1071')");
  const wrong = [];
  for (const state of ["cannot_answer", "no_history", "dispute", "not_a_question"]) {
    run(w, `render({state:'${state}',message:'m'})`);
    if (q(w, ".btn-retry")) wrong.push(`${state} offered a retry`);
  }
  for (const [n, wantRetry, wantRoute] of [[0, true, false], [1, true, false], [2, false, true]]) {
    run(w, `retries=${n}; render({state:'error',message:'m'})`);
    if (Boolean(q(w, ".btn-retry")) !== wantRetry) wrong.push(`error at ${n} retries: retry wrong`);
    if (Boolean(q(w, ".handoff")) !== wantRoute) wrong.push(`error at ${n} retries: route wrong`);
  }
  return wrong.join("; ");
});

check("DOM-11", 8, "Every response carries its question and a label", async (w) => {
  run(w, "select('INV-1071')");
  const wrong = [];
  for (const state of ["answer", "cannot_answer", "dispute", "not_a_question", "out_of_scope"]) {
    run(w, `lastAsk={question:'the question I asked',opts:{}}`);
    run(w, `render({state:'${state}',message:'m',answer:'a',citations:[]})`);
    if (q(w, ".asked")?.textContent !== "the question I asked") wrong.push(`${state}: no question shown`);
    if (!q(w, ".state-label")?.textContent.trim()) wrong.push(`${state}: no label`);
  }
  return wrong.join("; ");
});

check("DOM-12", 9, "The payment panel is live on an unpaid invoice, and not otherwise", async (w) => {
  const wrong = [];
  for (const [inv, wantReady] of [["INV-1071", true], ["INV-1085", false], ["INV-1058", false]]) {
    run(w, `select('${inv}')`);
    const ready = q(w, ".side").classList.contains("side-ready");
    if (ready !== wantReady) wrong.push(`${inv}: side-ready=${ready}`);
  }
  return wrong.join("; ");
});

check("DOM-13", 10, "The Q&A exists only inside an open invoice, and names it", async (w) => {
  if (q(w, ".ask-panel")) return "a Q&A panel exists with no invoice open";
  const wrong = [];
  for (const inv of ["INV-1071", "INV-1042"]) {
    run(w, `select('${inv}')`);
    const panels = qa(w, ".ask-panel");
    if (panels.length !== 1) wrong.push(`${inv}: ${panels.length} panels`);
    if (!panels[0]?.closest(".invoice-detail")) wrong.push(`${inv}: panel is not inside the invoice`);
    const head = q(w, ".ask-head")?.textContent ?? "";
    if (!head.includes(inv)) wrong.push(`${inv}: header reads "${head}"`);
  }
  run(w, "select(null)");
  if (q(w, ".ask-panel")) wrong.push("panel survived closing the invoice");
  // nothing anywhere lets a question be aimed at a different invoice
  const selects = qa(w, "select").filter((el) => !el.disabled);
  if (selects.length) wrong.push(`${selects.length} enabled picker(s) on the page`);
  return wrong.join("; ");
});

/* --- runner --------------------------------------------------------------- */

export async function runDom(record) {
  for (const c of cases) {
    let detail = "";
    try {
      const w = await boot();
      detail = await c.fn(w);
      w.close();
    } catch (err) {
      detail = `threw: ${err.message}`;
    }
    record(c.id, `INV${c.invariant}`, c.name, detail === "", detail);
  }
}
