# Invoice Q&A prototype

A working prototype of a self-service Q&A feature for a customer-facing invoice portal. A payer asks a plain-language question about their invoice and gets an answer **grounded in their actual invoice records**, with every figure cited back to the source line item.

The point is getting the invoice paid. People don't pay invoices they don't understand. Some will ask the merchant and wait; more mean to ask and never do, so the invoice ages on a question nobody ever heard. This answers it while they're still looking at the invoice, from their own records, and then offers the two things that move it forward: pay now, or write to the merchant about whatever the records can't settle.

Invoices are the setting, but the shape is general: open-ended questions, answers bounded by records the organisation already holds.

Built against the spec in [`docs/invoice_qa_feature_spec.md`](docs/invoice_qa_feature_spec.md). The spec came first; the prototype implements it. The table below maps each acceptance criterion to where it lives in the code and the question that exercises it.

---

## What this is

This is a proof of concept rather than a product. The data is entirely fictional and fixed. The prototype was built with Claude Code to explore how a draft spec and a prototype develop against each other in AI-driven development: the spec was drafted first, building against it tested the requirements, and the issues it exposed went back into the spec.

The point of this approach is the early surfacing and addressing of problems. Working this way puts something running in front of customers, product architects, and engineering leads while the spec is still a draft, so the ambiguity and the gotchas come out there. What reaches engineering is a spec whose issues have already been explored and resolved. The alternative is finding them mid-sprint, after engineering has committed to a date.

## Evaluate the prototype

`npm install && npm run eval:offline` runs 33 deterministic checks against the routing and guardrails in a few seconds, with no API key. A further 22 exercise model behaviour and need a key. Each names the acceptance criterion it exercises. If the guardrails don't hold, that is where it shows.

Retrieval is a filter over a fixed dataset, not an index. See [What's stubbed, and what's real](#whats-stubbed-and-whats-real).

---

## Run it

**Prerequisites:** Node 18+ and an Anthropic API key ([console.anthropic.com](https://console.anthropic.com/settings/keys)). A full evaluation session costs a few cents.

```bash
npm install
cp .env.example .env      # then paste your key into .env
npm start
```

Open <http://localhost:3000>.

The key is read server-side only and is never sent to the browser. If it's missing, the app says so plainly rather than failing silently.

---

## What it does

The dataset is one fictional customer, Marrow & Co., buying industrial parts from Ferro Supply Co. Their invoice history is deliberately varied: a late fee, an added line item, a supplier price rise, a larger order, one invoice flagged as contested, and one old enough to fall outside the retrieval window.

Clicking an invoice number opens it, showing its line items, fees and total. The Q&A lives inside that invoice and answers only against it. There is no picker and no way to ask across the account.

One test control remains, fenced and labelled: a button to simulate a system failure, so you can see AC5's state looks nothing like a decline. Questions to try are in the table below, one per criterion.

### How a question is handled

```
question
   │
   ├─ authorization check ─────────────► generic "couldn't find that invoice"
   │
   ├─ classify intent (Claude, structured output)
   │      │
   │      ├─ dispute ───────────────────► never answered; offer a route to a person
   │      ├─ cross-merchant ────────────► disclosed as out of scope
   │      └─ nothing actually asked ────► say what the assistant is for, and stop
   │
   ├─ retrieve (bounded to 12 months)
   │
   └─ answer (Claude, structured output)
          ├─ grounded ──────────────────► answer + inline citations
          ├─ no supporting records ─────► "can't answer confidently"
          └─ no prior invoice ──────────► "nothing earlier to compare"
```

**The classification is the model's job; the routing off it is ordinary code.** Dispute detection is deterministic rather than left to the answering model to police itself, because in a financial context a confident wrong answer is worse than no answer.

---

## Spec traceability

| Spec | Behaviour | Code | Try |
|---|---|---|---|
| **AC1** | Grounded answer; every figure cited inline to invoice + line item | `server.js` → `answer()`, `ANSWER_SCHEMA` | Open **INV-1014**, ask *"why was I charged a late fee?"* |
| **AC2** | Decline when zero supporting records. **No retry**, since it's a data outcome rather than a fault | `lib/core.js` → `decidePostAnswer()` | Open **INV-1071**, ask *"when will my next order ship?"* |
| **AC3** | No earlier invoice to compare against, stated as such rather than as a confidence failure | `lib/core.js` → `decidePostAnswer()` | Open **INV-1001**, ask *"why is this higher than the one before it?"* |
| **AC4** | Dispute-shaped question is never answered. Nothing is sent to the merchant; the customer is offered the AC10 handoff | `lib/core.js` → `decidePreAnswer()` | Open **INV-1071**, ask *"I never received this shipment, I want a refund"* |
| **AC5** | Operational failure, visually distinct from AC2, with Retry; support route after 2 failed retries | `server.js` catch → `app.js` retry counter | Click **Simulate a system failure** inside any invoice, or `npm run eval` case ON-18 |
| **AC6** | Authorization runs *before* retrieval; mismatch returns a non-disclosing "couldn't find that invoice". Retrieval also strips merchant-internal annotations, so they reach neither the screen nor the model | `lib/core.js` → `authorizeInvoice()`, `payerVisible()` | Stubbed, see below; `npm run eval` cases OFF-19 / ON-20 |
| **AC7** | The question is always about the invoice on screen. No picker, no account-wide state | `app.js` → `askPanel()` | `npm run eval:offline` case DOM-13 |
| **AC8** | Opening a different invoice takes any displayed answer with it. Anything typed and not yet sent survives and is offered back, and every response shows the question it answers | `app.js` → `select()`, `drafts`, `clearDraft()` | `npm run eval:offline` cases DOM-03 to DOM-06 |
| **AC9** | Automated answers disclosed as such: persistent panel notice naming the data source, plus a label on every response so attribution survives a screenshot | `index.html` → `.disclosure`; `app.js` → `labelFor()` | `npm run eval:offline` case DOM-11 |
| **AC10** | One consent-based route to a person: write a message. Offered on a decline, a dispute, or a direct request to reach the merchant. The invoice reference travels; the question put to the assistant never does | `server.js` → `/api/route-to-merchant`; `app.js` → `routeAction()` | Open any invoice and ask something dispute-shaped, or *"how do I contact them?"* |
| **AC11** | A handoff is confirmed **only** when the support channel accepted it; a failed send says so and offers retry | `server.js` → `/api/route-to-merchant`; `app.js` → `send()` catch | `npm run eval` cases ON-14 / ON-15; `eval:offline` DOM-08 |
| **AC12** | Taking neither route transmits nothing and records nothing against the customer | `app.js` → nothing fires without a click | `npm run eval` case ON-17; `eval:offline` DOM-07 |
| **AC13** | Payment offered wherever the invoice is unpaid, leading on an answer and sitting below the complaint on a dispute-shaped question. Never on a disputed invoice | `lib/core.js` → `offersPayment()`, `paymentIsPrimary()` | `npm run eval:offline` cases OFF-20, DOM-09, DOM-12 |
| **AC14** | Nothing is sent without a second, deliberate confirmation showing what will go. The same message is never sent twice, and what was sent stays available | `server.js` → dedupe guard; `app.js` → `confirmStep()`, `sentList()` | `npm run eval` case ON-21; `eval:offline` DOM-01, DOM-02, DOM-07 |
| Non-Goal | 12-month retrieval window; older history disclosed, never silently used | `lib/core.js` → `windowCutoff()` | Open **INV-1071**, ask *"why is this more expensive than a year and a half ago?"* |
| Non-Goal | Cross-merchant questions disclosed as out of scope, not folded into AC2 | `lib/core.js` → `decidePreAnswer()` | Open any invoice, ask *"what's in my order from Acme Corp?"* |
| Spec §Edge | Partial retrieval is treated as a decline, never a partial answer with a guessed remainder | `answer()` system prompt, rule 3 | Open **INV-1071**, ask *"why is the freight higher than on INV-1058?"* |


---

## Evals

The table above claims the criteria are met. This is how to check it.

```bash
npm run eval:offline    # deterministic guardrails, no API key, no server
npm run eval            # the above, plus end-to-end against the model
```

Cases live in [`evals/cases.json`](evals/cases.json), tagged by criterion. Two suites, because they give different kinds of evidence.

**Offline (33 cases): what the system cannot do.** The guardrails are ordinary code, not model behaviour, so these hold whatever the model says on the day. A dispute-shaped classification cannot reach the answer path. Retrieval cannot return an invoice from outside the 12-month window, or the merchant's internal notes. A disputed invoice cannot get a Pay button. It also runs AC1's groundedness check: every figure in an answer must have a matching entry in `citations`.

Thirteen of those cases load the page into jsdom and drive it, because the browser holds the only real session state in the app: what has been sent, what is half-typed, and what was sent a moment ago. Every fault found by hand in this repo came from a combination of those, each rule correct on its own, so [`evals/state-model.md`](evals/state-model.md) writes the combinations down and [`evals/dom.js`](evals/dom.js) asserts them. Still no key and no server.

```
  PASS  OFF-01  AC4      Dispute intent never reaches the answer path
  PASS  OFF-08  Window   Retrieval is bounded to the 12-month window
  PASS  OFF-15  AC1      Groundedness check catches an uncited figure
  PASS  DOM-01  INV1     The sent record appears exactly once, in every state
  PASS  DOM-09  INV6     Payment and routing match the state model, in order
  ...
  33/33 passed
```

**Online (22 cases): what the model did on this run.** Eighteen go end to end through the live model, four exercise the handoff. A green run says it behaved on these twenty-two, not that it always will. Needs the server running and a key set.

To check the harness can actually fail, change the dispute branch in `lib/core.js` to `if (false)`. OFF-01 and OFF-02 fail with the reason.

**What a green run doesn't tell you.** Nothing here judges how it looks or how it reads: styling, wording and whether an answer is worth having still need a person. A figure cited to the *wrong* line item passes the groundedness check and is still wrong. And the spec's release gate wants ≥50 golden pairs at ≥99% groundedness in CI; this is 55 cases run by hand.

---

## How the spec was produced

The spec was drafted, then run through a multi-agent validation workflow built in Claude Code. Fifteen read-only agents check it in parallel: testability, scope, ambiguous language, edge cases, technical context. Their findings become clarifying questions. The rewrite runs only after those are answered, and no agent both judges and rewrites.

It looks for requirements that read as clear but can't be tested. Here it found three criteria resting on the word "confidently" with nothing checkable behind it, no citation format on the claim that mattered most, no separation between "I can't answer" and "the system is down", and no authorization behaviour at all. Each became a criterion you can write a test against. That is why the table above points at `evals/cases.json` and not at a reviewer's opinion.

**Building the prototype to that spec then changed the spec eleven times.** Reviewing a document catches requirements that can't be tested. Building the feature catches requirements that are wrong. AC4 said to tell the customer their dispute had been routed to the merchant, when nothing had been sent anywhere: a developer would have built exactly that, and every customer raising a dispute would have been told something untrue.

Requirements defects, not coding defects, and cheaper to find here than after engineering has built to them. It doesn't finish the job; the spec still has open questions needing customer research, architecture and legal. The eleven changes are in [`docs/decisions.md`](docs/decisions.md).

The validators live in [`pm-spec-workflow`](https://github.com/J-Hunniford/pm-spec-workflow) (private repo).

---

## What's stubbed, and what's real

Everything in the traceability table is real code. These are the places the prototype stands in for something a platform would provide.

**Authorization.** One hardcoded customer, so `authorizeInvoice()` can't do a real ownership comparison. The check still runs before retrieval and returns the right non-disclosing message; production would compare the invoice's customer against the session's.

**Retrieval.** The dataset is a fixed JSON file, so retrieval is a filter and nothing persists between restarts. At production scale it becomes a real index.

**Payment.** AC13 has the Q&A point at the portal's payment flow rather than handle it, so the panel on the right comes to life instead. Taking payment is a Non-Goal, and the panel says so if you press its button.

**The invoice view.** Deliberately minimal. It exists so the Q&A panel sits inside an invoice rather than beneath a list.

**The feature name.** "Ask" is a placeholder. Naming a customer-facing feature is a decision for product, marketing and exec leadership after a POC, which is why none appears in the acceptance criteria.

**Model choice.** Both calls use `claude-opus-5`, the classifier at low effort since it's a constrained labelling task. In production that one is an obvious candidate for a cheaper model.

Product decisions sit in the spec, not here: what v1 leaves out is in its Non-Goals, and what remains unresolved, including which system carries the message to the merchant, is in Open Questions.

---

## Layout

```
├── server.js                 # HTTP layer, both Claude calls
├── lib/
│   └── core.js               # routing, retrieval window, auth, groundedness
│                             #   pure, no I/O, so the guardrails are testable
├── evals/
│   ├── cases.json            # golden cases, tagged by acceptance criterion
│   ├── state-model.md        # what the browser must show, in every combination
│   ├── dom.js                # that model, asserted in jsdom
│   └── run.js                # offline + online runner
├── public/                   # single-page UI
│   ├── index.html
│   ├── app.js                # render states, retry logic, message compose
│   └── styles.css
├── data/
│   └── synthetic_invoice_data.json   # fixture + test questions + notes
└── docs/
    └── invoice_qa_feature_spec.md
```

`data/synthetic_invoice_data.json` carries a `test_notes` object saying which invoice to open for the non-obvious test questions, and what each is meant to exercise. Worth reading before testing the history window or partial retrieval.
