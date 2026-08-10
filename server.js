import "dotenv/config"; // loads .env into process.env before anything reads it
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeContext,
  authorizeInvoice,
  inWindowInvoices,
  decidePreAnswer,
  decidePostAnswer,
} from "./lib/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(here, "public")));

const MODEL = "claude-opus-5";

const dataset = JSON.parse(
  fs.readFileSync(path.join(here, "data", "synthetic_invoice_data.json"), "utf8"),
);
/* Routing and retrieval logic lives in lib/core.js, kept free of I/O so
   the guardrails can be tested without a model call. See evals/. */
const ctx = makeContext(dataset);

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ timeout: 60_000 })
  : null;

const SESSION = { customerName: dataset.customer.name };

/* ---------------------------------------------------------------------------
 * Stage 1 — classify intent.
 *
 * Classifying is the model's job; deciding what to do about it is ordinary code
 * below. So disputes and ambiguity get handled the same way every time, instead
 * of relying on the answering model to police itself. That's what the spec's
 * guardrails are for.
 * ------------------------------------------------------------------------- */
const CLASSIFIER_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: ["factual", "comparative", "dispute", "cross_merchant", "contact_request", "not_a_question"],
    },
    referenced_invoice_ids: { type: "array", items: { type: "string" } },
    implies_older_history: { type: "boolean" },
    needs_history: { type: "boolean" },
  },
  required: [
    "intent",
    "referenced_invoice_ids",
    "implies_older_history",
    "needs_history",
  ],
  additionalProperties: false,
};

async function classify(question, selectedInvoice) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: CLASSIFIER_SCHEMA },
    },
    system: [
      "You classify a customer's question about their invoice. You do not answer it.",
      "",
      'intent "dispute": the customer is disputing a charge or requesting a refund. Refund requests, denial of receipt or delivery, chargeback language, "I want my money back". Intent to dispute outranks every other label, even if the message also asks a factual question.',
      'intent "cross_merchant": the question is about a merchant other than the one on this invoice.',
      'intent "comparative": compares two or more invoices, or asks why an amount changed. This includes a question about one invoice that can only be answered by looking at others: "why is this so expensive", "why is this one higher", "is this normal". Judging whether an amount is high requires something to judge it against, so treat these as comparative and set needs_history true.',
      'intent "factual": a direct question about a specific invoice.',
      'intent "contact_request": the customer is asking to reach the merchant, or how to, rather than asking about the invoice itself: "I want to ask Ferro a question", "how do I contact them", "can I speak to someone before I pay". They are asking for something the system can give them, so this is not the absence of a question.',
      'intent "not_a_question": there is no question in the message at all. Venting, insults, greetings, thanks, chit-chat. "i hate ferro" and "hello" are this. A question you cannot answer from the records is still a question: "what discount will you give me next quarter" is asking something, so classify it normally and let the answering step decline. Use this label only when nothing is being asked.',
      "",
      "referenced_invoice_ids: invoice IDs named explicitly in the question. Empty if none.",
      "implies_older_history: true if answering would require invoices older than 12 months.",
      "needs_history: true if answering requires more than the invoice in view.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Merchant: ${dataset.merchant.name}`,
          `Invoice currently in view: ${selectedInvoice ? selectedInvoice.invoice_id : "none"}`,
          `Today's date: ${dataset.query_time}`,
          "",
          `Customer's question: ${question}`,
        ].join("\n"),
      },
    ],
  });
  return JSON.parse(response.content.find((b) => b.type === "text").text);
}

/* ---------------------------------------------------------------------------
 * Stage 2 — answer, grounded in retrieved records only (AC1, AC2, AC7).
 * ------------------------------------------------------------------------- */
const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["answered", "no_supporting_records", "no_comparison_history"],
    },
    answer: { type: "string" },
    needs_merchant: { type: "boolean" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          invoice_id: { type: "string" },
          line_item: { type: "string" },
          amount: { type: "number" },
        },
        required: ["invoice_id", "line_item", "amount"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "answer", "needs_merchant", "citations"],
  additionalProperties: false,
};

async function answer(question, records, selectedInvoice) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { format: { type: "json_schema", schema: ANSWER_SCHEMA } },
    system: [
      "You answer a customer's question about their own invoices, using ONLY the records provided in the user message.",
      "",
      "Rules, in priority order:",
      "1. Never state a figure that does not appear in the provided records. Never estimate, infer, or recall a number from general knowledge. This includes figures you work out yourself: do not state differences, sums, totals or percentages you calculated. Give the source figures and let the customer see the change; writing \"$25.00 more\" is not allowed when no record contains 25.00.",
      "2. Write for the customer, in plain sentences. Every figure you state must appear in the citations array, and must carry a marker in the text giving its position in that array, counting from 1: \"Freight is $85.00 [1], up from $60.00 [2].\" Use the marker and nothing else. Do not write out invoice numbers or line-item names alongside a figure; the reader has the sources listed beneath the answer. Refer to an invoice by name only where the sentence genuinely needs it, such as when comparing two of them.",
      '3. If the records do not support every figure the answer needs, set status to "no_supporting_records" and leave answer empty. A partial answer with a guessed remainder is worse than no answer.',
      '4. Use status "no_comparison_history" ONLY when the records contain no invoice earlier than the one in view, so there is genuinely nothing to compare against. It is not for questions naming a period you have no records from.',
      "4b. Never state that records do not exist. You are shown what retrieval returned, not the whole account, so \"there are no earlier invoices on file\" may be false. Say what you can see, or that this question needs more than you were given.",
      "5. If the customer asks about a period the records do not reach back to, but earlier records do exist, answer from the earliest records you have and say which period your answer covers. Never claim there is nothing to compare against while comparable records are present.",
      "6. Set needs_merchant true when part of what was asked can only be answered by the merchant themselves: their intentions, whether or when they will make contact, what they will decide, or anything beyond these records. This applies when you CAN answer some of the question from the records: answer that part, set the flag, and do not speculate about the rest. If the records support nothing the question asked for, rule 3 governs instead and the status is no_supporting_records; the flag is irrelevant there because a decline already routes the customer to a person.",
      "7. Describe what the records show in the customer's terms, never the shape of the data. They have invoices, charges and payments; they do not have a fees list, a field, a record set or a null value. Say \"no late fee has been charged on it\", not \"its fees list is empty\".",
      "8. Be brief and direct. Answer the question asked; do not add advice or next steps. Stay on the invoice the customer asked about. Other invoices are for explaining that one, so bring in only the comparison that answers the question and leave the rest alone. Listing every charge across the account is not an answer, and a customer who asked about one invoice does not want a tour of six.",
      "9. Where something is genuinely the merchant's to decide, say so warmly rather than as a refusal. \"Ferro Supply Co. would be able to confirm\" reads as help; \"that is for Ferro Supply Co. to decide\" reads as a door closing. Never end on the limitation if you can end on what you do know.",
      "10. But do not defer to the merchant over something the customer can settle themselves. If the invoice in view is outstanding and not disputed, and the question is about a charge or a consequence that paying would resolve, such as whether a late fee will be added, answer from the records and stop. Do not set needs_merchant. The customer has a direct way to close the matter and pointing them at a conversation only delays it.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Today's date: ${dataset.query_time}`,
          `Merchant: ${dataset.merchant.name}`,
          `Customer: ${dataset.customer.name}`,
          `Invoice in view: ${selectedInvoice ? selectedInvoice.invoice_id : "none"}`,
          "",
          "Retrieved records:",
          JSON.stringify(records, null, 2),
          "",
          `Customer's question: ${question}`,
        ].join("\n"),
      },
    ],
  });
  return JSON.parse(response.content.find((b) => b.type === "text").text);
}

/* ---------------------------------------------------------------------------
 * Routing.
 * ------------------------------------------------------------------------- */
app.get("/api/invoices", (_req, res) => {
  res.json({
    merchant: dataset.merchant,
    customer: dataset.customer,
    queryTime: dataset.query_time,
    invoices: inWindowInvoices(ctx),
  });
});

/* AC10 — forward an unanswered question to the merchant, with its invoice
   context, so the customer doesn't have to restate it. Stubbed here: the
   merchant support channel is a dependency assumed to exist (see the spec's
   Technical Constraints), same assumption AC4's dispute routing rests on. */
/* Recent handoffs, so a double click or a resubmitted page can't send the
   same thing twice. In production this belongs in the support channel with a
   proper window and identity; here it demonstrates that the guard exists on
   the server rather than only in the browser. */
const recentHandoffs = new Map();

/* Long enough to absorb a double-click, a refresh, or a back-button
   resubmission, which is what this guards against. Not a quota on how often a
   customer may contact their supplier: someone with a second thing to say a
   minute later is not making a mistake. */
const HANDOFF_WINDOW_MS = Number(process.env.HANDOFF_WINDOW_MS ?? 60_000);

app.post("/api/route-to-merchant", (req, res) => {
  const { invoiceId, message, simulateFailure } = req.body ?? {};

  /* Only what the customer typed themselves. The question they put to the
     assistant is never accepted here, because it was not written for this
     audience. Nor is a bare "this customer has a query" notification: it tells
     the merchant something happened without saying what, leaving them no move
     except to make contact and ask. */
  const composed = typeof message === "string" ? message.trim() : "";
  if (!composed) {
    return res.status(400).json({ ok: false, reason: "nothing to send" });
  }

  // AC11 — the forward can fail, and a failure must never be reported as a
  // success. Test hook, same idea as the AC5 one: a stubbed channel won't fail
  // on its own, and a success path you can't test isn't worth much.
  if (simulateFailure) {
    return res.status(503).json({ ok: false, reason: "support channel unreachable" });
  }

  // The point is fewer interruptions for a small business, so sending the same
  // request twice works against the feature rather than for it.
  const key = `${invoiceId ?? "none"}::${composed}`;
  const seen = recentHandoffs.get(key);
  if (seen && Date.now() - seen < HANDOFF_WINDOW_MS) {
    return res.status(409).json({ ok: false, reason: "already sent" });
  }
  recentHandoffs.set(key, Date.now());
  console.log(
    `[route→merchant] ${dataset.merchant.name} | invoice: ${invoiceId ?? "none"} | ` +
      `message: "${composed}"`,
  );
  res.json({ ok: true, merchant: dataset.merchant.name });
});

app.post("/api/ask", async (req, res) => {
  const { invoiceId, question, simulateFailure } = req.body ?? {};

  if (!question || !question.trim()) {
    return res.status(400).json({ state: "invalid", message: "Ask a question first." });
  }

  // Test hook, so the operational-failure path (AC5) can be shown without
  // having to break the network. Documented in the README.
  if (simulateFailure) {
    return res.status(503).json({
      state: "error",
      message: "Something went wrong reaching your invoice records just now.",
    });
  }

  // Config problems get their own state. Retrying won't conjure up a missing
  // key, so a Retry button here would just be lying to whoever clicks it.
  if (!anthropic) {
    return res.status(500).json({
      state: "config",
      message:
        "ANTHROPIC_API_KEY is not set. Copy .env.example to .env, add your key, then restart the server.",
    });
  }

  // AC6 — authorization runs before any retrieval.
  const auth = authorizeInvoice(ctx, invoiceId);
  if (!auth.ok) {
    return res.json({
      state: "not_found",
      message: "I couldn't find that invoice.",
    });
  }
  const selected = auth.invoice;

  try {
    const intent = await classify(question, selected);

    // Stage 1 — disputes, cross-merchant questions and messages with nothing
    // asked are decided in code, before the answering model is called at all.
    const pre = decidePreAnswer(ctx, intent, selected);
    if (pre.terminal) return res.json(pre.terminal);

    const result = await answer(question, pre.records, selected);

    // Stage 2 — the model reports a status; turning that into what the
    // customer sees, and the older-history notice, happen in code.
    return res.json(decidePostAnswer(ctx, intent, result));
  } catch (err) {
    // AC5 — anything operational lands here, visibly distinct from AC2 above.
    console.error("[ask] operational failure:", err.message);
    return res.status(503).json({
      state: "error",
      message: "Something went wrong reaching your invoice records just now.",
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`\n  Ask About This Invoice — running at http://localhost:${port}`);
  console.log(`  Customer: ${SESSION.customerName}  |  Merchant: ${dataset.merchant.name}`);
  if (!anthropic) {
    console.log("\n  ⚠  ANTHROPIC_API_KEY is not set — questions will return an error.");
    console.log("     cp .env.example .env, add your key, then restart.\n");
  } else {
    console.log("");
  }
});
