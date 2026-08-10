/* ---------------------------------------------------------------------------
 * Core decision logic. Pure functions, no I/O, no model calls.
 *
 * The spec claims the model classifies but ordinary code decides what happens
 * next. Keeping that code here rather than inside the Express handler is what
 * lets you check the claim: everything below runs without a network call, a
 * server, or an API key.
 *
 * Each function takes an explicit `ctx` instead of reading module state, so a
 * test can hand it whatever dataset the case needs.
 * ------------------------------------------------------------------------- */

export const RETRIEVAL_WINDOW_MONTHS = 12; // Spec: Technical Constraints

/** Build the context object the functions below operate on. */
export function makeContext(dataset) {
  return {
    invoices: dataset.invoices,
    merchantName: dataset.merchant.name,
    queryTime: new Date(dataset.query_time),
    windowMonths: RETRIEVAL_WINDOW_MONTHS,
  };
}

/* --- what the payer is entitled to see ----------------------------------- */

/**
 * Notes the merchant's own staff keep on an account. They aren't printed on the
 * invoice and the payer has no claim on them. A note reading "customer contacted
 * us claiming the shipment never arrived" is the supplier writing down their
 * view of a complaint, not a fact about the bill.
 *
 * Retrieval is bounded by entitlement as well as by date. Whatever comes out of
 * here is safe to show the customer and safe to hand to the model, which can't
 * leak what it never had.
 */
export const MERCHANT_INTERNAL_FIELDS = ["internal_note", "internal_notes", "notes"];

export function payerVisible(invoice) {
  const copy = { ...invoice };
  for (const f of MERCHANT_INTERNAL_FIELDS) delete copy[f];
  return copy;
}

export function payerVisibleAll(invoices) {
  return invoices.map(payerVisible);
}

/* --- retrieval window ---------------------------------------------------- */

export function windowCutoff(ctx) {
  const cutoff = new Date(ctx.queryTime);
  cutoff.setMonth(cutoff.getMonth() - ctx.windowMonths);
  return cutoff;
}

export function inWindowInvoices(ctx) {
  const cutoff = windowCutoff(ctx);
  return payerVisibleAll(
    ctx.invoices.filter((i) => new Date(i.issue_date) >= cutoff),
  );
}

export function outOfWindowInvoices(ctx) {
  const cutoff = windowCutoff(ctx);
  return ctx.invoices.filter((i) => new Date(i.issue_date) < cutoff);
}


/* --- AC6: authorization -------------------------------------------------- */

/**
 * Runs before any retrieval. A miss mustn't reveal whether the invoice exists,
 * so the caller says the same thing either way.
 */
export function authorizeInvoice(ctx, invoiceId) {
  if (!invoiceId) return { ok: true, invoice: null };
  const invoice = ctx.invoices.find((i) => i.invoice_id === invoiceId);
  // Production would compare invoice.customer_id against the session's customer.
  return invoice
    ? { ok: true, invoice: payerVisible(invoice) }
    : { ok: false, invoice: null };
}

/* --- routing, stage 1: what to do with a classification ------------------ */

/**
 * Decides what happens once the classifier returns, before anything is
 * generated. Either a terminal response, or a go-ahead to answer plus the
 * records retrieval should be limited to.
 *
 * Disputes are checked first and unconditionally. The answering model never
 * sees a dispute-shaped question, so nobody can talk it into answering one.
 */
export function decidePreAnswer(ctx, intent, selected) {
  // AC4 — dispute-shaped questions are never answered.
  if (intent.intent === "dispute") {
    return {
      terminal: {
        state: "dispute",
        message:
          `I can only answer from what's on your invoices. Raising a dispute, asking for a refund or reporting a problem is something ${ctx.merchantName} will need to handle.`,
      },
    };
  }

  /* They want to reach the merchant rather than ask about the invoice, and
     that's something we can actually do for them. Offer the route, and keep the
     payment route as well, because someone asking a question before paying has
     just said they mean to pay. Answering "nothing to look up" would turn away
     a customer who told you both things. */
  if (intent.intent === "contact_request") {
    return {
      terminal: {
        state: "contact_request",
        message: `You can send ${ctx.merchantName} a message here, and they'll reply to you directly.`,
      },
    };
  }

  /* Nothing was asked. Someone letting off steam hasn't failed to ask a
     question, and offering to forward it is the worst thing we could do: it
     invites them to send something they'll regret to a supplier they still have
     to deal with. Say what this is for and leave it there. */
  if (intent.intent === "not_a_question") {
    return {
      terminal: {
        state: "not_a_question",
        message: selected
          ? `I answer questions about your invoices and payments. Ask me anything about ${selected.invoice_id} and I'll look it up.`
          : "I answer questions about your invoices and payments. Ask me something and I'll look it up.",
      },
    };
  }

  // Non-Goal — cross-merchant questions are out of scope and disclosed as such,
  // not folded into the low-confidence decline.
  if (intent.intent === "cross_merchant") {
    return {
      terminal: {
        state: "out_of_scope",
        message: `I can only answer questions about your invoices from ${ctx.merchantName}, so to ask about another merchant's invoice, open it from their list.`,
      },
    };
  }

  // Retrieval, bounded to the window.
  const named = payerVisibleAll(
    ctx.invoices.filter((i) => intent.referenced_invoice_ids.includes(i.invoice_id)),
  );
  const inWindow = inWindowInvoices(ctx);
  let records;
  if (intent.needs_history || intent.intent === "comparative") {
    records = inWindow;
  } else {
    records = [selected, ...named].filter(Boolean);
    if (records.length === 0) records = inWindow;
  }

  return { proceed: true, records };
}

/* --- routing, stage 2: what to do with an answer ------------------------- */

/**
 * Decides the final response once the answering model returns. The model
 * reports a status; turning that status into something the customer sees is
 * done here, not left to the model.
 */
export function decidePostAnswer(ctx, intent, result) {
  if (result.status === "no_comparison_history") {
    return { state: "no_history", message: decodeStrayEscapes(result.answer) };
  }

  // AC2 — decline. No retry offered: this is a data outcome, not a fault.
  if (result.status === "no_supporting_records") {
    return {
      state: "cannot_answer",
      message:
        "I can't answer that confidently from your invoice records.",
    };
  }

  // Non-Goal — history older than the window is disclosed, never silently used.
  const older = outOfWindowInvoices(ctx);
  const notice =
    intent.implies_older_history && older.length > 0
      ? `Heads up: this answer only covers the last ${ctx.windowMonths} months. Older invoices on this account aren't included.`
      : null;

  return {
    state: "answer",
    answer: decodeStrayEscapes(result.answer),
    citations: result.citations,
    notice,
    // Part of the question was about the merchant's own intentions, which no
    // invoice record contains. The answer stands; the rest needs a person, so
    // the customer is offered the same handoff a decline would give them.
    needsMerchant: Boolean(result.needs_merchant),
  };
}


/* Models sometimes over-escape inside a JSON string, so "\u2014" survives
   parsing as six literal characters, or a stray backslash gets left in front of
   a word. Either one shows up on screen looking like the page is broken. No
   answer about an invoice has any business containing a backslash, so anything
   left after decoding is junk. */
export function decodeStrayEscapes(text) {
  if (!text) return text;
  return String(text)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}


/* --- AC13: when to offer payment ----------------------------------------- */

/**
 * The whole point is getting invoices paid sooner, so once the question has been
 * dealt with and the invoice is simply unpaid, paying is the obvious next step
 * and comes before any route to the merchant.
 *
 * Never on a disputed invoice. That depends on the INVOICE, not on how this
 * particular question got classified. "Why is this so expensive" asked about a
 * contested charge classifies as an ordinary question, and a Pay button under it
 * would look like the merchant chasing money on a bill the customer has already
 * challenged.
 */
export function offersPayment(invoice, state) {
  if (!invoice) return false;
  if (invoice.status === "paid" || invoice.disputed) return false;
  return ["answer", "cannot_answer", "no_history", "dispute", "contact_request", "not_a_question"]
    .includes(state);
}

/**
 * Where the payment route sits relative to the route to a person.
 *
 * Paying leads only where the question was actually answered, because that is
 * the case where paying settles the matter. Everywhere else the customer is
 * still owed something: an answer we could not give, a complaint, a request to
 * reach the merchant. Leading with a Pay button there reads as "we could not
 * help you, now pay us", so the route to a person goes first and paying sits
 * underneath, available rather than pushed.
 *
 * The payment route is still offered in all of those cases. Removing it only
 * guarantees the invoice stays unpaid while the customer writes and waits.
 */
export function paymentIsPrimary(state) {
  return state === "answer";
}

/* --- AC1: groundedness check --------------------------------------------- */

/**
 * Pull currency figures out of the answer text. AC1 says every figure has to
 * carry the invoice and line item it came from, so a figure the citations don't
 * account for is a claim with nothing behind it.
 */
export function extractFigures(text) {
  if (!text) return [];
  const matches = text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? [];
  return matches.map(normaliseFigure);
}

function normaliseFigure(raw) {
  const n = Number(String(raw).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

/**
 * Figures in the answer with no matching citation amount. An empty array means
 * every number traces back to a cited source, which is what AC1 actually claims
 * and the part worth checking by machine.
 */
export function uncitedFigures(answer, citations = []) {
  const cited = new Set(
    citations
      .map((c) => normaliseFigure(c.amount))
      .filter((v) => v !== null),
  );
  return extractFigures(answer).filter((f) => f !== null && !cited.has(f));
}
