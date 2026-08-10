/* The AC13 rules, copied from lib/core.js because public/ is plain script and
   cannot import from lib/. OFF-20 runs both copies over every invoice and every
   response state and fails if they disagree, so the duplication cannot drift. */
function offersPayment(invoice, state) {
  if (!invoice) return false;
  if (invoice.status === "paid" || invoice.disputed) return false;
  return ["answer", "cannot_answer", "no_history", "dispute", "contact_request", "not_a_question"]
    .includes(state);
}
const paymentIsPrimary = (state) => state === "answer";

const rowsEl = document.getElementById("invoice-rows");
const searchEl = document.getElementById("search");
const countEl = document.getElementById("record-count");
const merchantNameEl = document.getElementById("merchant-name");
const merchantMetaEl = document.getElementById("merchant-meta");
const sideBalanceEl = document.getElementById("side-balance");

/* The Q&A lives inside the open invoice, so these are created with it rather
   than existing on page load. */
let formEl = null;
let inputEl = null;
let buttonEl = null;
let resultEl = null;

let invoices = [];
let customerName = "";
let merchantName = "";
let queryTime = null;
let selectedId = null;
let retries = 0; // AC5 — retry attempts for the current question
let lastAsk = null;

/* What has already been sent to the merchant in this session: invoice id to a
   list of { invoiceId, merchant, message, when }, oldest first. A list rather
   than one record, because a customer may send a follow-up and the earlier
   message must not vanish when they do. Two jobs. It stops the same request going
   twice, because the feature exists to reduce interruptions reaching a small
   business and repeat sends do the opposite. And it lets the customer see
   exactly what left, which is the only way the choice in AC10 stays
   meaningful after the moment has passed. Server-side deduplication backs the
   first job; production would persist the second. */
const sentToMerchant = new Map();

/* Unsent work, keyed by invoice. Opening a different invoice rebuilds the
   panel, which would otherwise discard a half-written message to the merchant
   without a word. Losing someone's typing silently is not an acceptable cost
   of navigating, and a draft they composed carefully is worse to lose than a
   question they can retype. */
const drafts = new Map();

/* Invoices whose confirmation is currently on screen in the panel, so the
   invoice-level record does not render a second copy alongside it. */
const justSent = new Set();

/* A draft holds two independent things: a question being typed into the ask
   box, and a message being composed to the merchant. Finishing one must not
   discard the other, so fields are dropped individually and the entry goes only
   when nothing is left in it. */
function clearDraft(id, field) {
  const d = drafts.get(id);
  if (!d) return;
  const { [field]: _done, ...rest } = d;
  if (Object.keys(rest).length) drafts.set(id, rest);
  else drafts.delete(id);
}

const money = (n) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const shortDate = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
};
/* Phrased to sit inside a sentence rather than to be hung off the end of one:
   "...on 7 Aug at 16:38." */
const sentStamp = (d) =>
  `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} at ` +
  d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const longDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/* The status is what the platform holds: open or paid. How late an invoice is
   is arithmetic on its due date, and whether it is contested is a separate
   flag, so both are shown as tags beside the status rather than as values of
   it. Putting a computed label in a status column invents vocabulary the
   platform may not have, which is the same fault as inventing a status for a
   dispute. */
function statusOf(inv) {
  return inv.status === "paid" ? "Paid" : "Open";
}

function statusTags(inv) {
  const tags = [];
  if (inv.disputed) tags.push({ text: "Disputed", cls: "tag-disputed" });
  if (inv.status !== "paid") {
    const daysLate = Math.floor((queryTime - new Date(inv.due_date)) / 86_400_000);
    if (daysLate > 0) {
      tags.push({ text: `${daysLate} day${daysLate === 1 ? "" : "s"} late`, cls: "tag-late" });
    }
  }
  return tags;
}

const balanceOf = (inv) => (inv.status === "paid" ? 0 : inv.total);

/* --- load ---------------------------------------------------------------- */

async function load() {
  const res = await fetch("/api/invoices");
  const data = await res.json();
  invoices = data.invoices;
  customerName = data.customer.name;
  queryTime = new Date(data.queryTime);
  merchantName = data.merchant.name;
  merchantNameEl.textContent = merchantName;
  merchantMetaEl.textContent = data.merchant.type;
  renderRows();
}

function renderRows() {
  const term = searchEl.value.trim().toLowerCase();
  const shown = [...invoices]
    .reverse()
    .filter((i) => !term || i.invoice_id.toLowerCase().includes(term));

  rowsEl.innerHTML = "";
  for (const inv of shown) {
    const tr = document.createElement("tr");
    if (inv.invoice_id === selectedId) tr.className = "is-selected";

    /* Clicking an invoice number opens the invoice, which is what that link
       does in any portal. AC7's question context follows from having opened
       it, rather than the click being a bespoke Q&A control. */
    const link = document.createElement("button");
    link.className = "inv-link";
    link.textContent = inv.invoice_id;
    link.setAttribute("aria-expanded", String(inv.invoice_id === selectedId));
    link.onclick = () =>
      select(inv.invoice_id === selectedId ? null : inv.invoice_id);

    const statusTd = td(statusOf(inv));
    for (const t of statusTags(inv)) {
      const tag = document.createElement("span");
      tag.className = t.cls;
      tag.textContent = t.text;
      statusTd.append(" ", tag);
    }

    tr.append(
      cellWith(link),
      td(customerName),
      td(shortDate(inv.issue_date)),
      td(shortDate(inv.due_date)),
      numTd(money(balanceOf(inv))),
      statusTd,
    );
    rowsEl.append(tr);

    if (inv.invoice_id === selectedId) rowsEl.append(detailRow(inv));
  }

  countEl.textContent = `${shown.length} record${shown.length === 1 ? "" : "s"} total`;
}

/* The opened invoice. The spec places the Q&A "embedded in the customer-facing
   invoice view", so the feature needs an invoice view to be embedded beneath.
   Everything here comes from the same records retrieval is bounded to. */
function detailRow(inv) {
  const tr = document.createElement("tr");
  tr.className = "detail-row";
  const cell = document.createElement("td");
  cell.colSpan = 6;
  tr.append(cell);

  const box = document.createElement("div");
  box.className = "invoice-detail";
  cell.append(box);

  const head = document.createElement("div");
  head.className = "detail-head";
  head.innerHTML =
    `<span class="detail-id">${inv.invoice_id}</span>` +
    `<span class="detail-dates">Issued ${longDate(inv.issue_date)} · Due ${longDate(inv.due_date)}` +
    (inv.paid_date ? ` · Paid ${longDate(inv.paid_date)}` : "") +
    `</span>`;
  box.append(head);

  const table = document.createElement("table");
  table.className = "detail-lines";
  const body = document.createElement("tbody");

  const lineRow = (label, amount, cls = "") => {
    const r = document.createElement("tr");
    if (cls) r.className = cls;
    const l = document.createElement("td");
    l.textContent = label;
    const a = document.createElement("td");
    a.className = "num";
    a.textContent = money(amount);
    r.append(l, a);
    return r;
  };

  for (const li of inv.line_items ?? []) body.append(lineRow(li.description, li.amount));
  if (inv.subtotal != null && (inv.fees ?? []).length)
    body.append(lineRow("Subtotal", inv.subtotal, "detail-sub"));
  for (const f of inv.fees ?? []) body.append(lineRow(f.description, f.amount, "detail-fee"));
  body.append(lineRow("Total", inv.total, "detail-total"));

  table.append(body);
  box.append(table);

  /* Only what is printed on the invoice. The merchant's own annotations never
     reach the browser: lib/core.js strips them at retrieval. */
  if (inv.note) {
    const note = document.createElement("p");
    note.className = "detail-note";
    note.textContent = inv.note;
    box.append(note);
  }

  /* A record of what was sent, for a customer returning to this invoice. Not
     shown at the moment of sending: the confirmation in the panel below is
     doing that job, and two copies of the same thing on one screen reads as a
     fault. */
  const sent = sentToMerchant.get(inv.invoice_id);
  if (sent?.length && !justSent.has(inv.invoice_id)) {
    const rec = sentList(sent);
    rec.className = "detail-sent";
    box.append(rec);
  }

  box.append(askPanel(inv));
  return tr;
}

/* The only test control in the interface, and fenced so it cannot be mistaken
   for part of the feature. AC5 requires the failure state to look unlike a
   decline, which is a thing to be seen rather than asserted, so a reviewer
   needs a way to trigger it. Everything else the scaffolding used to do is
   done by the eval suite. */
function failureHook() {
  const wrap = document.createElement("div");
  wrap.className = "test-hook";

  const label = document.createElement("span");
  label.className = "test-hook-label";
  label.textContent = "Prototype control, not part of the feature";

  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Simulate a system failure";
  b.onclick = () =>
    ask(inputEl.value || "Has this invoice been paid?", { simulateFailure: true });

  wrap.append(label, b);
  return wrap;
}

/* The Q&A belongs to the invoice, not to the page: there is always exactly one
   invoice in question, and it is the one open on screen. */
function askPanel(inv) {
  const panel = document.createElement("div");
  panel.className = "ask-panel";

  const head = document.createElement("div");
  head.className = "ask-head";
  head.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>' +
    `<span>Ask about ${inv.invoice_id}</span>`;
  panel.append(head);

  formEl = document.createElement("form");
  formEl.autocomplete = "off";
  formEl.className = "ask-form";

  const row = document.createElement("div");
  row.className = "ask-row";
  inputEl = document.createElement("input");
  inputEl.type = "text";
  /* Describes the field rather than proposing a question. A placeholder
     holding a real question reads as a suggestion, but cannot be used as one:
     the customer has to retype it, and it disappears the moment they start. */
  inputEl.placeholder = "What would you like to know?";
  buttonEl = document.createElement("button");
  buttonEl.type = "submit";
  buttonEl.className = "ask-button";
  buttonEl.textContent = "Ask";
  row.append(inputEl, buttonEl);
  formEl.append(row);

  // AC9 — persistent, non-dismissible, and it names the data behind the answers.
  const disc = document.createElement("p");
  disc.className = "disclosure";
  disc.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';
  const discText = document.createElement("span");
  discText.textContent = `Answers are automated, and are based only on your invoices from ${merchantName}`;
  disc.append(discText);
  formEl.append(disc);

  inputEl.value = drafts.get(inv.invoice_id)?.question ?? "";
  inputEl.addEventListener("input", () => {
    const d = drafts.get(inv.invoice_id) ?? {};
    drafts.set(inv.invoice_id, { ...d, question: inputEl.value });
  });

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    retries = 0;
    ask(inputEl.value);
  });
  panel.append(formEl);

  resultEl = document.createElement("div");
  resultEl.setAttribute("aria-live", "polite");
  panel.append(resultEl);

  /* An unsent message survives navigating away. Without this the compose box
     goes with the panel and the customer's words go with it. */
  const draft = drafts.get(inv.invoice_id)?.message;
  if (draft) {
    const resume = document.createElement("div");
    resume.className = "draft-resume";
    const note = document.createElement("p");
    note.className = "support";
    note.textContent = `You have an unsent message for ${inv.invoice_id}.`;
    const btn = document.createElement("button");
    btn.className = "btn-route";
    btn.type = "button";
    btn.textContent = "Finish it";
    btn.onclick = () => {
      resume.replaceWith(routeAction({ openCompose: true }));
    };
    resume.append(note, btn);
    panel.append(resume);
  }

  panel.append(failureHook());
  return panel;
}

function td(text) {
  const el = document.createElement("td");
  el.textContent = text;
  return el;
}
function numTd(text) {
  const el = td(text);
  el.className = "num";
  return el;
}
function cellWith(node) {
  const el = document.createElement("td");
  el.append(node);
  return el;
}


function select(id) {
  /* Navigating away takes the on-screen confirmation with it, so the record
     on the invoice becomes the thing that carries it from here. */
  justSent.clear();
  selectedId = id || null;

  const inv = invoices.find((i) => i.invoice_id === selectedId);
  sideBalanceEl.value = inv ? balanceOf(inv).toFixed(2) : "0.00";

  /* The point of the feature is getting the invoice paid, so the payment
     route is visible from the moment a payable invoice is opened rather than
     only after a question has been asked. Not on a settled invoice, and not on
     one under formal dispute (AC13). */
  const side = document.querySelector(".side");
  if (side) {
    const payable = inv && inv.status !== "paid" && !inv.disputed;
    side.classList.toggle("side-ready", Boolean(payable));
    side.classList.remove("side-called");
    const n = document.getElementById("side-note");
    if (n) n.textContent = "Payment is out of scope for this prototype.";
  }

  /* AC8 — the Q&A is rebuilt with the invoice, so opening a different one
     cannot leave an answer about the previous invoice on screen. Closing the
     invoice takes the panel with it. */
  renderRows();
}

searchEl.addEventListener("input", renderRows);


/* --- ask ----------------------------------------------------------------- */

async function ask(question, opts = {}) {
  if (!question.trim()) return;

  /* Once asked, it is no longer a draft. Leaving it in the box means anyone
     wanting to follow up has to clear it first, and the saved draft would put
     it back on returning to the invoice. lastAsk keeps it for Retry. */
  if (inputEl) inputEl.value = "";
  if (selectedId) clearDraft(selectedId, "question");
  // The payment pane lights up when the customer is sent there; a new question
  // means they have moved on, so it returns to normal.
  document.querySelector(".side")?.classList.remove("side-called");
  lastAsk = { question, opts };
  buttonEl.disabled = true;
  buttonEl.textContent = "Asking…";
  resultEl.innerHTML =
    '<p class="thinking">Checking your invoice records…</p>';
  resultEl.scrollIntoView({ block: "nearest", behavior: "smooth" });

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceId: selectedId, question, ...opts }),
    });
    render(await res.json());
  } catch {
    render({
      state: "error",
      message: "Something went wrong reaching your invoice records just now.",
    });
  } finally {
    buttonEl.disabled = false;
    buttonEl.textContent = "Ask";
  }
}

/* --- result states ------------------------------------------------------- */

/* Built per response rather than held as a constant, so the two that name the
   merchant use the same name the body text does instead of "the supplier". */
const labelFor = (state) =>
  ({
    answer: "Automated answer",
    cannot_answer: "Can't answer confidently",
    no_history: "No earlier invoice to compare",
    dispute: `Contact ${merchantName}`,
    out_of_scope: "Out of scope",
    contact_request: `Message ${merchantName}`,
    not_a_question: "No question found",
    not_found: "Not found",
    error: "Something went wrong",
    config: "Setup needed",
    invalid: "",
  })[state];

/* AC1 — a figure's source is shown at the point of the claim, as a marker
   pointing into the numbered list beneath. Spelling the invoice and line item
   out inline made the attribution longer than the sentence carrying it, and
   repeated everything the Sources list already said. Built as text nodes, so
   an answer can never inject markup. */
function renderWithMarkers(el, text) {
  const parts = String(text).split(/(\[\d+\])/g);
  for (const part of parts) {
    if (/^\[\d+\]$/.test(part)) {
      const sup = document.createElement("sup");
      sup.className = "cite-marker";
      sup.textContent = part.slice(1, -1);
      el.append(sup);
    } else if (part) {
      el.append(document.createTextNode(part));
    }
  }
}

/* The feature exists to get invoices paid sooner. Where the question has been
   answered and the invoice is simply outstanding, the useful next step is
   payment rather than a conversation, which only adds a round trip to
   something they could close now. Absent on a dispute: someone telling you the
   goods never arrived should not be shown a Pay button. */
function payAction(inv, { quiet = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = quiet ? "actions pay-action pay-action-quiet" : "actions pay-action";

  const btn = document.createElement("button");
  btn.className = quiet ? "btn-pay-now btn-pay-quiet" : "btn-pay-now";
  btn.type = "button";
  btn.textContent = quiet
    ? `Or pay ${money(balanceOf(inv))} now`
    : `Pay ${money(balanceOf(inv))} now`;
  btn.onclick = () => {
    // AC13 routes to the portal's own payment flow rather than reimplementing
    // it. Here that flow is the panel on the right, so bring it to life.
    const side = document.querySelector(".side");
    side.scrollIntoView({ block: "center", behavior: "smooth" });
    side.classList.add("side-ready");
    // Restart the attention pulse even if it is already ready.
    side.classList.remove("side-called");
    void side.offsetWidth;
    side.classList.add("side-called");
    document.getElementById("pay-invoice")?.focus({ preventScroll: true });
  };

  const note = document.createElement("span");
  note.className = "support";
  note.textContent = inv.status === "paid" ? "" : `Due ${longDate(inv.due_date)}.`;

  wrap.append(btn, note);
  return wrap;
}

function render(data) {
  resultEl.innerHTML = "";
  const box = document.createElement("div");
  box.className = `result ${data.state}`;

  /* The question leaves the box when it is asked, so the answer would
     otherwise sit on screen with nothing saying what it answers. Obvious in
     the moment; not a minute later, and not at all to someone returning to a
     decline and wondering what they had said. */
  if (lastAsk?.question) {
    const asked = document.createElement("p");
    asked.className = "asked";
    asked.textContent = lastAsk.question;
    box.append(asked);
  }

  const label_ = labelFor(data.state);
  if (label_) {
    const label = document.createElement("div");
    label.className = "state-label";
    // AC9 — the label rides with the response, so attribution survives the
    // response being screenshotted or forwarded away from the panel.
    if (data.state === "answer") {
      label.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/>' +
        '<path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>';
    }
    label.append(label_);
    box.append(label);
  }

  const body = document.createElement("p");
  if (data.state === "answer") {
    renderWithMarkers(body, data.answer);
  } else {
    body.textContent = data.message;
  }
  box.append(body);

  // AC1 — every figure traceable to a source record.
  if (data.state === "answer" && data.citations?.length) {
    const cites = document.createElement("div");
    cites.className = "citations";
    cites.innerHTML = "<h3>Sources</h3>";
    const ul = document.createElement("ol");
    for (const c of data.citations) {
      const li = document.createElement("li");
      li.textContent = `${money(c.amount)} · ${c.invoice_id} · ${c.line_item}`;
      ul.append(li);
    }
    cites.append(ul);
    box.append(cites);
  }

  if (data.notice) {
    const n = document.createElement("div");
    n.className = "notice";
    n.textContent = data.notice;
    box.append(n);
  }


  // AC5 — Retry on operational failure only; support route after two
  // failed retries. AC2 deliberately offers no retry.
  if (data.state === "error") {
    const actions = document.createElement("div");
    actions.className = "actions";
    if (retries < 2) {
      const b = document.createElement("button");
      b.className = "btn-retry";
      b.type = "button";
      b.textContent = "Retry";
      b.onclick = () => {
        retries += 1;
        ask(lastAsk.question, lastAsk.opts);
      };
      actions.append(b);
    } else {
      const s = document.createElement("span");
      s.className = "support";
      s.textContent = "Still not working.";
      actions.append(s);
    }
    box.append(actions);
    if (retries >= 2) box.append(routeAction()); // AC10
  }

  // AC4 / AC2 / AC3 — every unanswerable outcome offers the same consent-based
  // handoff. Nothing is sent unless the customer chooses it.
  /* Payment first, where paying is what settles the question. Not on a
     dispute: the customer is contesting the charge, and a Pay button there
     reads as pressure rather than help. */
  // AC13 — the rule itself lives in lib/core.js, where the evals can reach it.
  const openInv = invoices.find((i) => i.invoice_id === selectedId);
  const showPay = offersPayment(openInv, data.state);
  const showRoute =
    ["cannot_answer", "no_history", "dispute", "contact_request"].includes(data.state) ||
    (data.state === "answer" && data.needsMerchant);

  /* Paying leads where the question was answered. Otherwise the route to a
     person leads and paying follows it, quietened only because something sits
     above it: with no route offered there is nothing to be quiet against. */
  const payLeads = showPay && paymentIsPrimary(data.state);
  if (payLeads) box.append(payAction(openInv));
  if (showRoute) box.append(routeAction());
  if (showPay && !payLeads) box.append(payAction(openInv, { quiet: showRoute }));

  if (data.state === "not_found") {
    const s = document.createElement("div");
    s.className = "actions";
    const span = document.createElement("span");
    span.className = "support";
    span.textContent = "Contact support if you think that's wrong.";
    s.append(span);
    box.append(s);
  }

  resultEl.append(box);
}

/* Merchant names often end in a full stop ("Ferro Supply Co."). Use this ONLY
   where a full stop follows immediately, so the two do not collide. Anywhere
   else, including before a question mark, use merchantName unchanged: "Ferro
   Supply Co.?" is correct and "Ferro Supply Co?" is not. */
const merchantInline = () => merchantName.replace(/\.$/, "");

/* AC4 / AC10 / AC11 — the handoff to a person.
 *
 * Nothing is transmitted without the customer choosing it, and the question
 * they asked the assistant is never forwarded. It was written to a machine,
 * and people write differently to machines; a line typed in irritation is not
 * one they chose to send to their supplier.
 *
 * Writing nothing is a supported outcome. Nothing is sent, nothing is recorded
 * against them, and the offer is still here if they come back.
 */
/* What was sent, kept visible afterwards. A customer who wrote something in
   irritation and then walked away should be able to come back and see exactly
   what reached their supplier, rather than remembering it worse than it was. */
/* `fresh` is the moment of sending, where the confirmation is the reply to an
   action just taken. Everywhere else this is a record of something that
   happened earlier, and saying a message "is now with" the merchant next to a
   time from two days ago reads as a fault. Different tense, and the time goes
   in the sentence rather than after it. */
/* Every message sent about this invoice, oldest first. Only the newest can be
   the one just sent, so only it can carry the present-tense confirmation. */
function sentList(recs, { freshest = false } = {}) {
  const wrap = document.createElement("div");
  if (recs.length > 1) {
    const n = document.createElement("p");
    n.className = "sent-count";
    n.textContent = `${recs.length} messages sent about this invoice.`;
    wrap.append(n);
  }
  recs.forEach((rec, i) =>
    wrap.append(sentRecord(rec, { fresh: freshest && i === recs.length - 1 })),
  );
  return wrap;
}

function sentRecord(rec, { fresh = false } = {}) {
  const wrap = document.createElement("div");

  const line = document.createElement("p");
  line.className = "routed";
  line.textContent = fresh
    ? `Your message about invoice ${rec.invoiceId} is now with ${merchantInline()}.`
    : `You messaged ${merchantName} about invoice ${rec.invoiceId} on ${sentStamp(rec.when)}.`;
  wrap.append(line);

  const det = document.createElement("details");
  det.className = "sent-detail";
  const sum = document.createElement("summary");
  sum.textContent = "See what was sent";
  det.append(sum);

  const dl = document.createElement("dl");
  dl.className = "sent-record";
  const row = (label, value, cls = "") => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (cls) dd.className = cls;
    dd.textContent = value;
    dl.append(dt, dd);
  };

  row("Invoice", rec.invoiceId);
  row("To", rec.merchant);
  row("Message", rec.message, "sent-message");

  det.append(dl);
  wrap.append(det);
  return wrap;
}

function routeAction({ openCompose = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "handoff";
  /* Reached only from inside an open invoice, so the invoice is never in
     question and never has to be asked for. */
  const key = selectedId;

  /* Already sent something about this invoice. A follow-up is a normal thing to
     need, so another is offered rather than refused; the server still refuses an
     identical message, which is what the duplicate rule was for.

     The record itself appears exactly once on screen. The invoice carries it,
     except in the moment just after sending, when the invoice row was built
     before the send and knows nothing about it. So the two conditions are
     complements: detailRow renders it unless the invoice is in justSent, and
     here we render it only if it is. */
  const already = sentToMerchant.get(key);
  if (already?.length && justSent.has(key)) {
    wrap.append(sentList(already, { freshest: true }));
  }

  const intro = document.createElement("p");
  intro.className = "handoff-intro";
  wrap.append(intro);
  const askedBefore = Boolean(already?.length);

  intro.textContent = askedBefore
    ? "Anything else to add?"
    : `Would you like to contact ${merchantName}?`;

  const choices = document.createElement("div");
  choices.className = "actions";

  const writeBtn = document.createElement("button");
  writeBtn.className = "btn-route";
  writeBtn.type = "button";
  writeBtn.textContent = askedBefore ? "Write another message" : "Write a message";

  choices.append(writeBtn);
  wrap.append(choices);

  const status = document.createElement("p");
  status.className = "support handoff-status";
  wrap.append(status);

  async function send(payload, onFail) {
    try {
      const res = await fetch("/api/route-to-merchant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceId: selectedId, ...payload }),
      });
      if (!res.ok) throw new Error();
      const record = {
        invoiceId: selectedId,
        merchant: merchantName,
        message: payload.message ?? null,
        when: new Date(),
      };
      const history = sentToMerchant.get(key) ?? [];
      history.push(record);
      sentToMerchant.set(key, history);
      if (selectedId) justSent.add(selectedId);
      clearDraft(key, "message"); // sent; a half-typed question is not

      wrap.innerHTML = "";
      wrap.append(sentList(history, { freshest: true }));
      const follow = document.createElement("p");
      follow.className = "support";
      follow.textContent = "They'll come back to you directly.";
      wrap.append(follow);
      /* Deliberately not re-rendering the invoice here. Doing so rebuilds the
         panel and takes the answer the customer is reading with it, and puts a
         second copy of this same confirmation above them. The record on the
         invoice is for when they come back later; right now they are looking
         at this one. */
    } catch {
      // AC11 — never confirm a send that did not happen.
      status.textContent = "That didn't send. Nothing has reached the merchant yet.";
      onFail();
    }
  }

  /* A send cannot be undone, so nothing goes without a second, deliberate
     action. It catches the mis-click, and it is the moment a message written
     in temper gets reconsidered. */
  function confirmStep(summary, onConfirm, onCancel) {
    wrap.querySelectorAll(".actions, .handoff-box, .handoff-note").forEach((n) => n.remove());
    intro.textContent = `Send this to ${merchantName}?`;

    const preview = document.createElement("p");
    preview.className = "handoff-confirm";
    preview.textContent = summary;

    const row = document.createElement("div");
    row.className = "actions";
    const yes = document.createElement("button");
    yes.className = "btn-route";
    yes.type = "button";
    yes.textContent = "Send";
    const no = document.createElement("button");
    no.className = "btn-route btn-route-quiet";
    no.type = "button";
    no.textContent = "Back";
    row.append(yes, no);

    yes.onclick = () => {
      yes.disabled = true;
      no.disabled = true;
      onConfirm(() => {
        yes.disabled = false;
        no.disabled = false;
        yes.textContent = "Try again";
      });
    };
    no.onclick = onCancel;

    wrap.insertBefore(preview, status);
    wrap.insertBefore(row, status);
  }

  const openComposeView = () => {
    choices.remove();
    intro.textContent = `Write what you'd like to say to ${merchantInline()}.`;

    const box = document.createElement("textarea");
    box.className = "handoff-box";
    box.rows = 4;
    box.placeholder = "Type your message…";
    box.value = drafts.get(key)?.message ?? "";
    box.addEventListener("input", () => {
      const d = drafts.get(key) ?? {};
      drafts.set(key, { ...d, message: box.value });
    });

    const note = document.createElement("p");
    note.className = "handoff-note";
    note.textContent =
      `Invoice ${selectedId} will be included, so there's no need to repeat it. Your question to the assistant is not sent.`;

    const row = document.createElement("div");
    row.className = "actions";
    const nextBtn = document.createElement("button");
    nextBtn.className = "btn-route";
    nextBtn.type = "button";
    nextBtn.textContent = "Continue";
    nextBtn.disabled = true;
    const cancel = document.createElement("button");
    cancel.className = "btn-route btn-route-quiet";
    cancel.type = "button";
    cancel.textContent = "Cancel";
    row.append(nextBtn, cancel);

    const syncNext = () => {
      nextBtn.disabled = box.value.trim().length === 0;
    };
    box.addEventListener("input", syncNext);
    syncNext();
    cancel.onclick = () => wrap.replaceWith(routeAction());
    nextBtn.onclick = () => {
      const text = box.value.trim();
      confirmStep(
        text,
        (onFail) => send({ message: text }, onFail),
        () => wrap.replaceWith(routeAction()),
      );
    };

    wrap.insertBefore(box, status);
    wrap.insertBefore(note, status);
    wrap.insertBefore(row, status);
    box.focus();
  };

  writeBtn.onclick = openComposeView;
  if (openCompose) openComposeView();

  return wrap;
}

/* The portal's pay button. Payment itself is a Non-Goal, so it says so once,
   briefly, at the point someone tries it, rather than announcing it in advance
   or sitting there greyed out. */
document.getElementById("pay-invoice")?.addEventListener("click", () => {
  const note = document.getElementById("side-note");
  if (note) note.textContent = "Payment isn't part of this prototype.";
  document.querySelector(".side")?.classList.add("side-called");
});

load();
