# UI state model

What the browser layer holds, and what must be true on screen for every
combination of it. This is the specification the DOM suite asserts against.
Three faults were found by hand in one afternoon, all of them combinations that
each looked correct on its own, so the invariants at the bottom matter more than
the tables above them.

## Session state

| Held | Shape | Written | Cleared |
|---|---|---|---|
| `selectedId` | invoice id or null | opening/closing an invoice | closing it |
| `sentToMerchant` | id → list of `{invoiceId, merchant, message, when}`, oldest first | on a confirmed send | never (session-lived) |
| `drafts` | id → `{question?, message?}` | on every keystroke in either box | `question` on submit; whole entry on a confirmed send |
| `justSent` | set of ids | on a confirmed send | on any navigation |
| `retries` | count | on Retry | on a new question |
| `lastAsk` | `{question, opts}` | on ask | never |

`justSent` exists for one reason: after a send, the invoice row was built before
the send and knows nothing about it, so the panel must carry the record instead.

## The opened invoice

| Element | Condition |
|---|---|
| line items, fees, total | always |
| `.detail-note` | invoice has a customer-visible note |
| `.detail-sent` (all messages) | messages exist for it **and** id not in `justSent` |
| `.draft-resume` | a saved `message` draft exists |
| ask panel | always |
| failure hook | always, fenced and labelled |

## Result box, by response state

| State | Pay | Route to person | Retry | Order |
|---|---|---|---|---|
| `answer` | if payable | only if `needsMerchant` | no | pay, then route |
| `cannot_answer` | if payable | yes | **no** | **route, then pay** |
| `no_history` | if payable | yes | no | **route, then pay** |
| `dispute` | if payable | yes | no | **route, then pay** |
| `contact_request` | if payable | yes | no | **route, then pay** |
| `out_of_scope` | no | no | no | — |
| `not_a_question` | if payable | **no** | no | pay only |
| `not_found` | no | no | no | support line only |
| `error` | no | after 2 retries | yes, twice | — |
| `config` | no | no | no | — |

"Payable" is the invoice being unpaid and not contested. It is a property of the
invoice, never of the response state.

Paying leads only where the question was answered. Everywhere else the route to
a person leads, because the customer is still owed something. Where no route is
offered at all, the Pay button is not quietened: there is nothing above it to be
quiet against.

## Handoff steps

`offer → compose → confirm → sent`, with `cancel` returning to `offer` from
either of the middle two. Nothing is transmitted before `confirm`. A failed send
returns to `confirm` with the failure stated and the button reading "Try again".

## Navigation

| Action | Effect |
|---|---|
| open another invoice | displayed response goes; `justSent` clears; drafts survive |
| close the invoice | panel and response go; drafts survive |
| submit a question | question leaves the box and the draft; message draft survives |
| send a message | whole draft entry goes; record gains an entry |

## Invariants

These must hold for **every** combination above. They are the assertions worth
writing, because each fault found by hand broke one of them while every
individual rule was correct.

1. The sent record appears **exactly once** on screen, never zero times when
   messages exist for the open invoice.
2. Every message sent remains retrievable. A later message never replaces an
   earlier one.
3. A displayed response always belongs to the invoice on screen.
4. Text the customer typed is never lost except by their own action.
5. Nothing is transmitted without an explicit confirm step.
6. A Pay button never appears on a paid or contested invoice, whatever was asked.
7. A Retry never appears on a decline, only on an operational failure.
8. Every response carries the question it answers and an automated-answer label.
