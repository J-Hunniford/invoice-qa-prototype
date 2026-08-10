# Feature Name: Ask About This Invoice

**Status:** Draft, portfolio/demonstration spec (v0.18)
**Author:** J-Hunniford
**Domain:** Customer Portal, AR Automation

---

## Overview

**A Q&A feature in the customer invoice portal, built to get invoices paid faster.**

Someone gets an invoice, doesn't follow a charge on it, and doesn't pay. A few will email or ring the merchant, which at a small business usually means interrupting the owner. Plenty more mean to ask, put it aside, and never get round to it.

That second group does the most damage, and it leaves no trace. No email arrives, no call comes in, so there's nothing for the merchant to answer and no sign anything is wrong. The invoice just sits there getting older. By the time it turns up on an overdue report, weeks have gone by over something that would have taken two minutes to explain. It also means support volume understates the problem, because the questions that never get raised are the ones that delay payment longest.

So the answer has to be there while they're still looking at the invoice, which is the only point at which they are both puzzled and minded to do something about it. They ask in plain words, get a reply built from their own records with every figure traceable back to where it came from, and then have two ways forward: pay it, or write to the merchant about whatever the records can't settle.

**Who it serves.** The payer gets an answer without waiting on a human reply. The merchant, who is the platform's paying customer, gets fewer "what is this charge" interruptions to answer by hand and, pending measurement, less confusion-driven delay in the payment cycle. For an SMB these questions arrive by phone or direct email to the owner or a single admin, not through a support queue.

**Why RAG rather than fine-tuning.** The questions are open-ended; the answers are not, being bounded by what the platform already holds about that customer. Invoice data is also per-customer and constantly changing, which is what fine-tuning is worst at, since it encodes stable patterns into model weights. So retrieve first and generate only from what was retrieved. An unconstrained chatbot asked "why is this invoice higher" will produce a fluent explanation with no relationship to the account, and a confident wrong answer on someone's bill is worse than no answer.

**Product vs architecture.** This spec defines what the feature must do, what "correct" means, and what gets escalated to a person. The retrieval mechanism, model choice and infrastructure are architecture's call and are deliberately not prescribed here.

---

## Goals

In priority order:

- **Settle the question that is holding up payment**, from the payer's own records, without them needing to email or telephone the merchant and wait for a reply.
- **Route to payment once the question is settled.** Where the invoice is outstanding and the answer resolves the matter, paying is the useful next step and the feature offers it. Sending a payer to a conversation they no longer need adds days to collection, which is the outcome this feature exists to reduce.
- Ground every answer in retrievable data with each figure traceable to source, and decline rather than guess where the records cannot support one.
- Route dispute- or refund-shaped questions to a person, on the customer's own terms, with settling the invoice offered below that rather than ahead of it. A payer who is annoyed can still pay; a payer whose invoice is formally disputed is never asked to.
- **Leave every answered question with a way forward.** An answer that resolves the matter offers payment. An answer that cannot offers a person. A question that ends in neither has cost the merchant a query and returned nothing.
- Reduce the interruptions reaching the merchant, and the confusion-driven delay in the payment cycle (see Success Metrics for how both are measured).

---

## Non-Goals

Explicitly out of scope for v1:

- **Language/locale:** non-English questions are not supported.
- **Channel:** the feature is web-portal only. Email, SMS, and voice are out of scope.
- **Multi-question bundling:** a single turn handles one question; bundled or multi-part questions in one message are not parsed as separate questions.
- **Conversational memory:** each question is answered independently. The system does not retain context across turns, so a follow-up phrased as a continuation ("and the one before that?") is treated as a new question and, if it cannot stand alone, is declined under AC2. Question context comes from the invoice the customer has open (AC7), not from conversation history.
- **Proactive surfacing:** the feature is invoked by the customer only. It does not proactively suggest questions or surface answers unsolicited.
- **History depth:** retrieval is scoped to a rolling 12-month window (see Technical Constraints). Questions implying older history are disclosed as out of scope, not silently dropped or guessed at.
- **Cross-merchant questions:** a customer's invoices from a different merchant on the same platform are not in scope.
- **Dispute/refund handling:** this feature does not process disputes or refunds. It detects them, declines to answer, and offers the customer a route to a person (see AC4 and AC10).
- **Action-taking:** the feature answers questions; it does not modify invoices, apply discounts, or take payment actions.
- **Behavioural targeting:** a payer's payment, dispute and query history is not used to vary what this feature tells them or how it prompts. Varying outreach by payer behaviour is a collections concern, handled in the outbound channels rather than here.

---

## User Stories

**Payer**

- As someone looking at an invoice I don't fully follow, I want to ask about it in my own words and get an answer built from my own invoices, with every figure showing where it came from, so I can work out what I owe without having to contact anyone.
- As someone with a question about a charge, I want it answered while I've got the invoice open, because if I have to send an email and wait I'll put it aside and probably not come back to it.
- As someone whose question has just been answered, I want to pay the invoice right there, so settling it doesn't turn into another job for later.
- As someone asking about something the records can't settle, I want to be told that plainly and pointed at a person, rather than handed a guess I can't tell apart from a fact.
- As someone raising a dispute or wanting a refund, I want to be told straight away that this needs a person, and given a way to reach one.
- As someone contacting my supplier, I want them to receive only what I actually wrote to them, not the question I typed into an assistant.
- As someone who has queried a charge, I don't want to be pressed to pay it while that's still open.

**Merchant**

- As a merchant, I want dispute-shaped and low-confidence questions kept away from automated answering entirely, so my customers never get wrong financial information with my name on it.
- As a merchant, I want a customer whose question has been answered to be able to pay immediately, because every extra step between understanding the bill and paying it is another day I'm waiting for the money.
- As a merchant, I want the notes my staff keep on an account kept out of what the customer sees, because they're written for us and not for them.

---

## Acceptance Criteria

### AC1: Grounded answer with citations (happy path)

> **Given** a customer is viewing an invoice in the portal and asks a question referencing that invoice or their invoices with the same merchant within the last 12 months,
> **When** retrieval returns one or more source records that directly support the figures/claims needed to answer,
> **Then** the system returns an answer, and every figure in the answer is accompanied inline by the invoice number and line-item reference it came from (e.g., "$142.00 on Invoice #INV-2041, line item 'Delivery surcharge'").

### AC2: Decline to answer (data/confidence miss)

> **Given** a customer asks a question,
> **When** retrieval returns zero source records that directly support any figure or claim the answer would need to make,
> **Then** the system displays "I can't answer that confidently," offers the handoff in AC10, and does not offer a retry (this is a data/confidence outcome, not a transient failure; see AC5 for the distinct system-failure path).

### AC3: Decline for want of a comparison baseline

> **Given** a customer asks a question that requires comparing the invoice in view against an earlier one,
> **When** the invoice in view is retrieved but no earlier invoice exists for that customer and merchant within the retrieval window,
> **Then** the system states that there is no earlier invoice to compare against, offers a route to human support, and does not offer a retry.

Separate from AC2 because retrieval succeeded here; only the comparison has no counterpart. Conflating them tells a customer the system can't answer confidently when the truth is there is nothing to compare against.

### AC4: Escalate dispute/refund-shaped questions

> **Given** a customer submits a question,
> **When** the intent classifier tags the message as dispute-shaped (e.g., refund request, denial of receipt, chargeback language),
> **Then** the system does not attempt to answer it, states plainly that nothing has been sent to the merchant, and offers the handoff in AC10.

Nothing is transmitted automatically. The words were written to an automated assistant, which is not the audience the customer was composing for, and a dispute is the case where a message is most likely to be written in anger. The customer decides what reaches their supplier.

### AC5: System/operational failure (distinct from AC2)

> **Given** a customer asks a question,
> **When** an operational failure occurs (retrieval timeout, backend/retrieval-service error, or session expiration) rather than a data/confidence miss,
> **Then** the system displays "Something went wrong," visually distinct from the AC2 "can't answer confidently" state, and offers a Retry action; after 2 failed retries, the system surfaces a route to human support.

### AC6: Authorization check precedes retrieval

> **Given** a customer's session is resolved to a customer_id,
> **When** the customer asks about a specific invoice,
> **Then** the system checks that the invoice belongs to that customer_id before any retrieval occurs; on mismatch, it displays a generic "we couldn't find that invoice" message with a support route, and does not disclose whether the invoice exists.

Authorization answers whether an invoice belongs to this customer, not which parts of it they are entitled to see. An AR record carries the merchant's own annotations: collection notes, credit assessments, characterisations of a complaint. Retrieval must strip those before records reach either the customer or the model. Telling the model not to repeat them is not a control, because it relies on the model behaving; stripping them at retrieval means it cannot leak what it never had.

### AC7: The question is always about the invoice on screen

> **Given** a customer has an invoice open in the portal,
> **When** the Q&A is displayed,
> **Then** it appears within that invoice, names it, and answers only against it; there is no separate control for choosing a different invoice and no state in which the question applies to the account as a whole.

No question can be asked about one invoice while another is on screen, so no answer can attach to the wrong one. Asking across the whole account is a plausible v2.

### AC8: Changing context clears a displayed response

> **Given** an answer or decline is on screen,
> **When** the customer opens a different invoice, or closes the one they had open,
> **Then** the displayed response goes with it.
> **Given** the customer has typed a question, or begun composing a message to the merchant, and not yet submitted it,
> **When** they open a different invoice and later return,
> **Then** what they typed is still there.
> **Given** a response is displayed,
> **When** the customer reads it,
> **Then** the question it answers is shown with it.

Answers and unsent work are treated differently on purpose: an answer beside the wrong invoice misleads, whereas discarding what someone typed loses their work. A question that has been asked is no longer unsent work, so it leaves the box on submission and a follow-up starts from an empty field.

### AC9: Automated answers are disclosed as such

> **Given** a customer is using the Q&A,
> **When** the panel is displayed, and again whenever a response is returned,
> **Then** the panel carries a persistent, non-dismissible statement that answers are generated automatically from the customer's own invoice records with this merchant; **and** every returned response is itself labelled as automated; **and** no response is presented in a way that attributes it to the merchant or to a person.

### AC10: An unanswered question can be routed to the merchant

> **Given** the system has declined to answer (AC2 or AC3), identified a dispute (AC4), reported an operational failure after 2 failed retries (AC5), answered only the part of a question the records support because the remainder depends on the merchant's own intentions, or been asked directly for a way to reach the merchant,
> **When** that response is displayed,
> **Then** the customer is offered a route to the merchant, writing a message of their own, and the invoice reference accompanies it; **and** the question the customer put to the assistant is never transmitted.

The fourth trigger is easy to miss: a question half in the records and half in the merchant's head needs both an answer and a route, not one or the other. The invoice reference travels automatically, since the system already holds it.

### AC11: A handoff to the merchant is confirmed only when it succeeded

> **Given** a message is being forwarded to the merchant's support channel by the customer's action under AC10,
> **When** the forward is accepted by that channel,
> **Then** the system confirms to the customer that it has been sent, and the confirmation names what was transmitted rather than confirming in the abstract; **and when** the forward fails, the system does not display a confirmation, states that nothing reached the merchant, and offers a retry.

State what went, not what did not: naming an absence invites the customer to picture the thing they were worried about. A false confirmation is the worst failure available here, because the customer stops chasing, the merchant never knew, and the invoice ages while both wait on the other.

### AC12: Choosing not to send transmits nothing

> **Given** the customer has been offered the handoff in AC10,
> **When** they do not use it, whether by navigating away, closing the portal, or simply leaving it,
> **Then** nothing is transmitted to the merchant, and no record of the interaction is made available to the merchant.

Walking away is a legitimate outcome, not something to recover from. Measure it in aggregate; never expose it per customer. The offer must remain available if they return later.

### AC13: Payment is offered where paying settles the matter

> **Given** the customer's question has been answered and the invoice in context is outstanding,
> **When** that response is displayed,
> **Then** the route to pay the invoice is offered as the primary next step, ahead of any route to the merchant.
> **Given** the question was not answered, whether declined (AC2, AC3), dispute-shaped (AC4), or a request to reach the merchant, and the invoice is outstanding,
> **When** that response is displayed,
> **Then** the payment route is still offered, below the route to a person rather than ahead of it.
> **Given** nothing was asked at all, and the invoice is outstanding,
> **When** the response is displayed,
> **Then** the payment route is offered and no route to the merchant is.
> **Given** the invoice in context is flagged as contested,
> **When** any response is displayed,
> **Then** no payment route is offered, whatever the question was.
> **Given** a customer opens an invoice that is unpaid and not flagged as contested,
> **When** the invoice is displayed,
> **Then** the route to pay it is visible and live from that moment, before any question has been asked.

Paying leads only where the question was answered, because that is where paying settles the matter. After a decline the customer is still owed something, and a Pay button above the route to a person reads as "we could not help you, now pay us". It is still offered, though: a question that sounds like a complaint is not a contested invoice, someone annoyed about a late delivery usually still owes the money, and removing the route only guarantees the invoice sits unpaid while they write and wait.

Where nothing was asked, paying is the only route offered. Forwarding a greeting or an insult to the merchant is not a service to either party.

Where the invoice has been formally contested the exception is absolute: pressing for payment on a bill the merchant has acknowledged is under challenge turns the feature from help into a collections tool.

Contested is held as a flag alongside the status, not a value within it, since a contested invoice is still outstanding. Whether the platform can hold such a flag is unverified and tracked in Open Questions. This routes to the portal's existing payment flow; processing payment remains a Non-Goal.

### AC14: A handoff is confirmed before it is sent, and not sent twice

> **Given** the customer has chosen to write a message under AC10,
> **When** they take that action,
> **Then** the system shows exactly what is about to be sent and requires a second, deliberate confirmation before transmitting it.
> **Given** the same message has already been sent for that invoice,
> **When** the customer attempts it again,
> **Then** the system does not transmit it a second time, and tells them the merchant already has it.
> **Given** the customer has already sent a message about an invoice,
> **When** they return to it,
> **Then** they are shown what they sent and may send a further, different message.
> **Given** a handoff has been sent,
> **When** the customer returns to that invoice or asks another question about it,
> **Then** a record of every message sent about that invoice remains available, not only the most recent, each showing its time, its recipient and the message itself.

A send cannot be recalled, so one click must not perform one. The guard is against the same thing arriving twice, not against a customer having more than one thing to say, and it sits on the server, since a rule that can be got round by refreshing is not a rule. The record is kept because people remember what they wrote in anger as worse than it was.

## Technical Constraints

*(Product-level inputs to architecture, not prescriptions of stack, model or infrastructure. Those remain architecture's call.)*

- **Data source:** invoice and payment records live in the platform's existing AR system of record. Retrieval reads from it, directly or via a derived index; the mechanism is architecture's decision.
- **Retrieval scope (v1):** the invoice in view, plus the same customer's invoices with the same merchant within a rolling 12-month window. The invoice in view is answerable whatever its own age. The window bounds the *additional* invoices retrieved to answer a question about it. Older history is out of scope for v1 (see Non-Goals) and is disclosed when a question implies it, never silently omitted.
- **Retrieval is bounded by entitlement as well as by date.** Merchant-internal annotations are removed before records are returned, so they reach neither the customer's screen nor the model's context. Enforced where records are retrieved, not by instruction to the model.
- **Authorization:** the session resolves to a customer_id, and an allowed-invoice check runs before retrieval (AC6). The prototype accompanying this spec stubs the check; production must implement it.
- **Release gate:** a golden evaluation set of at least 50 representative Q&A pairs, covering happy path, no-answer, no-comparison-baseline and dispute cases, must pass groundedness ≥ 99% and hallucination ≤ 1% in CI before any prompt, model or retrieval change ships. A starting bar, to be tuned as real usage data accrues.
- **The non-generative criteria are gated separately.** AC6 to AC14 are not generative behaviours and do not belong in a groundedness or hallucination measurement. They need their own deterministic suite, which must also gate release, because a correctness claim covering only the generative path leaves the guardrails unverified. The criteria that live in the browser need that suite to drive a rendered page, since their failures are combinations of state rather than wrong return values.
- **Support routing:** the feature integrates with the platform's existing merchant support flow rather than standing up a new channel. Whether that channel exists and has capacity is an Open Question.

---

## Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| Empty question submitted | Reject client-side; do not send an empty query to retrieval. |
| Malformed or oversized input | Reject with a clear message; do not pass to retrieval or the model. |
| Cross-merchant question | Treated as out of scope; disclosed as such, not silently dropped or misattributed to the wrong merchant. |
| Network failure (client to service) | System-failure state (AC5): "Something went wrong," Retry available. |
| Retrieval/backend error | System-failure state (AC5): "Something went wrong," Retry available. |
| Timeout | System-failure state (AC5); after 2 failed retries, surface support route. |
| Session expiration mid-interaction | System-failure state (AC5); customer is prompted to re-authenticate before retry. |
| Oversized history in scope window | Retrieval is bounded to the 12-month window regardless of volume; if the window itself contains more records than the retrieval mechanism can handle, that is a technical constraint for architecture to solve for, not a product behavior change. |
| Partial retrieval (some but not all needed records found) | Treated as a decline (AC2) if the retrieved records do not support the full set of figures/claims needed. The system does not answer part of a question with partial grounding and guess the rest. |
| Customer opens the message box and cancels without sending | Same as not using it at all. Nothing is transmitted, and the draft is kept for them (AC8). |
| Session expires between a response and the customer taking the AC10 handoff action | Re-authenticate before attempting the forward, consistent with the session-expiry row above; never confirm a send that did not happen. |
| Question refers to an invoice other than the one open | Answered against the open invoice only (AC7). A question naming another invoice is answered from the retrieval window, but the response belongs to the invoice on screen. |
| Message with nothing asked in it: venting, insults, greetings | Stated plainly that the assistant answers questions about invoices and payments; no answer attempted, no handoff offered, no payment prompted. Forwarding an expression of feeling to the merchant is the worst available response to it. |

---

## Success Metrics

| Metric | Definition | Target |
|---|---|---|
| Groundedness | % of factual claims in returned answers that trace to a cited retrieved source | ≥ 99% (CI release gate; see Technical Constraints) |
| Hallucination rate | % of answers containing at least one claim not supported by retrieved data | ≤ 1% (CI release gate) |
| Retrieval accuracy | % of questions for which the correct invoice(s) are retrieved | `[TBD: set from the golden eval set]` |
| Dispute detection recall | % of dispute- or refund-shaped questions correctly identified and never answered (AC4) | `[TBD: set from the golden eval set]` |
| Dispute detection precision | % of questions treated as dispute-shaped that genuinely were. A false positive refuses to answer an ordinary question, so both directions are measured | `[TBD: set from the golden eval set]` |
| Decline correctness | % of declines (AC2 and AC3) that were in fact unanswerable, rather than false declines on answerable questions | `[TBD: set from the golden eval set]` |
| Question deflection rate | % of questions asked that are answered in-portal without being routed to the merchant (AC10). Directly observable by the platform. | `[TBD: set from launch data]` |
| Payment conversion | % of answered questions where the invoice is paid in the same session. The feature's primary goal (AC13); directly observable by the platform | `[TBD: set from launch data]` |
| Handoff completion rate | % of customers offered the AC10 handoff who use it, measured in aggregate only. A low rate means the step is too heavy, not that those customers should be reported to the merchant (AC12). | `[TBD: set from launch data]` |
| Merchant-reported query load | Merchant's own estimate of invoice-understanding questions received per month, collected pre- and post-launch by survey | `[TBD: baseline not yet measured]` |
| Time-to-payment | Change in mean time-to-payment between merchants with the feature enabled and a matched holdout of merchants without it, over the same period | `[TBD: baseline not yet measured]` |

Groundedness and hallucination rate gate release; the rest are directional.

**Two caveats.** The platform cannot see the load this feature removes, because SMB invoice questions arrive by phone and email to the owner. Deflection is a proxy for it, and merchant self-report is the only real read. Deflection also counts a customer who read the answer and did nothing the same as one who paid; payment conversion is what separates them.

**Time-to-payment needs a holdout.** Customers who ask a question are self-selected, and whatever confused them plausibly correlates with paying late anyway, so comparing invoices where the feature was used against those where it wasn't measures the confound rather than the feature.

---

## Open Questions

- What is the right retention/audit policy for logged Q&A interactions, given they involve financial data? `[TBD]`
- Should the 12-month retrieval window be configurable per merchant, or fixed platform-wide? `[TBD]`
- What volume of dispute-shaped questions should be expected, and does the merchant support-routing channel have capacity for it? `[TBD]`
- **Does the platform operate any payer-facing support channel of its own?** AC10 routes to the merchant, which covers the substance of a bill. It does not cover a payer who cannot use the portal at all, such as a login failure the merchant cannot fix. That path is unspecified. `[TBD: confirm with support/ops]`
- **Should raising a query change anything on the invoice in the AR system, and can it?** Today it changes nothing, so the payer has no signal their query is live and nobody else in the merchant's business knows one is outstanding. Marking it *disputed* would be wrong: a question is not a dispute, and that status carries collection consequences that would suppress chasing on invoices nobody is contesting. A lighter signal is probably right, but the status vocabulary belongs to the AR system rather than to this feature. The second half is factual and unanswered: AC13 assumes an invoice can be flagged as contested, and the documented portal statuses are not known to include one. The platform does hold dispute history for a payer, so the capability may exist already in some form; establishing what it records, and whether it is per invoice or per account, would answer most of this. `[TBD: confirm with the owning team]`
- **Which system carries the message to the merchant, and how does the reply get back?** An architecture decision, and the feature's requirements hold whichever way it goes: AC12 nothing sent unchosen, AC10 the assistant's question never forwarded, AC11 confirmed only once accepted. Three options: the portal holds it, which is what the prototype does and leaves the reply path unsolved; hand off to the customer's mail client, which solves the reply path by not owning it, at the cost of the platform going blind; or the platform sends and owns the reply address, which keeps both and is the likely production answer.

  The reply path should drive the choice. If the merchant answers from their own inbox, the portal shows "sent" indefinitely and a customer answered last week may send again, producing the duplicate AC14 exists to prevent. Resolution also cannot be measured, since handoff completion counts messages leaving and nothing counts questions answered. `[TBD: architecture and the owning team]`

- **Should the platform screen the language of a message before passing it to the merchant?** The compose step and AC14's confirmation already prevent the main harm, since nothing written to the assistant is forwarded and the customer must address a person deliberately. Going further is a policy question rather than a technical one: whose standards apply, what a blocked customer is told, and whether a platform should edit what one business says to another. `[TBD: policy]`
- **AI transparency obligations need legal confirmation.** AC9 specifies disclosure as defensible practice. Whether it is also a requirement, in what form and in which markets, depends on regimes including the EU AI Act and emerging US state legislation, and on where this merchant's payers are. If a specific wording or placement is mandated, AC9 becomes the floor rather than the specification. `[TBD: legal review]`
- Latency budget is deliberately not fixed here. It is an architecture and UX collaboration, not a product-level number.

---

## Decision record

Eleven revisions, most of them prompted by using the prototype rather than by reviewing the document: [`decisions.md`](decisions.md).

---
