# Service blueprint

The diagram in the README shows what the system does with a question. This shows the whole service around it: what the payer does and sees at each step, what happens out of sight, and what the merchant would have to do. Steps 5 and 6 are handled by the platform's messaging, not this feature, but they're shown because the service doesn't work without them.

The prototype only covers the payer's side. Where a part of the service hasn't been designed, the blueprint says "Not designed yet" and links to the open question in the [spec](invoice_qa_feature_spec.md#open-questions). It doesn't guess how that part would work.

## The blueprint

Read across for the steps, and down for who or what is involved at each one. Everything above the dotted line is what the payer sees. Everything below it happens out of sight.

| | 1. Open an invoice | 2. Ask a question | 3. Read the response | 4a. Pay | 4b. Write to the merchant | 5. Get a reply *(platform messaging)* | 6. After the reply *(platform messaging)* |
|---|---|---|---|---|---|---|---|
| **What the payer sees** | The invoice, with its line items and total. A Pay button if it's unpaid and not contested. A notice saying answers are automated | Their question, which stays next to the response | One of three things: an answer with each figure cited, a message saying it can't answer, or "Something went wrong". Each is labelled as automated | The portal's normal payment page | The message they're about to send, to check before it goes. Then confirmation of what was sent, or a message saying nothing was sent | The merchant's reply, on the invoice in the portal and in an email | Not designed yet: what the screen offers after a reply |
| **What the payer does** | Opens an invoice they don't fully understand | Asks a question in their own words | Pays, writes to the merchant, or leaves it | Pays the invoice | Writes a message in their own words, and confirms it | Reads the reply, in the portal or in their email | Replies, in the portal or by email. Or pays, or leaves it |
| **What the screen does** | Shows the Q&A inside that invoice, so a question can only be about the invoice on screen | Rejects a question that's empty or too long | After an answer, shows Pay first. After a decline, shows the option to write to the merchant first. After a failure, offers Retry, then a way to contact support after two failures | Sends the payer to the payment page | Asks them to confirm before sending. Keeps a list of every message they've sent about the invoice | Shows the whole conversation on the invoice, in order, whichever way each message was sent | Same as step 5 |
| ┈┈┈┈┈┈ | ┈┈┈┈┈┈ | ┈┈┈┈┈┈ | ┈┈┈┈┈┈ | ┈┈┈┈┈┈ | ┈┈┈┈┈┈ | ┈┈┈┈┈┈ | ┈┈┈┈┈┈ |
| **What happens out of sight** | Code checks the invoice belongs to this payer | The LLM labels the question. Code decides what to do with the label. Disputes, requests to contact the merchant, questions about other merchants, and messages with no question in them are all handled by code, and never reach the LLM that writes answers | Code fetches the payer's invoices from the last 12 months and removes the merchant's internal notes. The LLM writes an answer using only those invoices. Code checks every dollar figure has a citation, and declines the answer if one doesn't | Nothing | Code checks again that the invoice belongs to this payer. It sends only what the payer wrote, never the question they asked. It won't send the same message twice | The platform receives the merchant's reply, adds it to the conversation on that invoice, and emails it to the payer | A payer's reply reaches the merchant the same way, by email and on the invoice. Not designed yet: the checks on a reply sent by email |
| **Systems used** | The merchant's invoice records | The LLM | The merchant's invoice records and the LLM | The portal's payment system (stood in for in the prototype) | The platform's messaging (stood in for in the prototype) | The platform's messaging, by email and in the portal | Same as step 5 |
| **People involved** | Nobody | Nobody | Nobody checks live answers yet. Not designed yet | Nobody | The merchant receives the message | The merchant replies by email | The merchant and the payer, for as long as the conversation goes on |

## What isn't designed yet

Each of these is an open question in the spec. None of them means the prototype is wrong. They're the parts a real service would need around it.

- **Showing a question is open.** Writing to the merchant doesn't change anything on the invoice. The payer has no sign their question is being dealt with, and nobody else at the merchant knows it's there. Marking the invoice as disputed would be wrong, because a question isn't a dispute. *Spec: Should raising a query change anything on the invoice in the AR system, and can it?*
- **Marking an invoice as contested.** The Pay button is hidden on a contested invoice. That only works if the platform can mark an invoice as contested, and nobody has confirmed it can. *Spec: same open question as above.*
- **Help the merchant can't give.** After two failures the payer is offered a way to contact support. If the problem is something only the platform can fix, such as not being able to log in, it isn't clear who they'd contact. *Spec: Does the platform operate any payer-facing support channel of its own?*
- **Whether the merchant can keep up.** Disputes and unanswered questions all go to the merchant. That assumes someone there has time to deal with them. *Spec: What volume of dispute-shaped questions should be expected, and does the merchant support-routing channel have capacity for it?*
- **Checking live answers (step 3).** Once the feature is live, nobody is responsible for checking that its answers are right. Doing that would mean keeping the questions, and how long to keep them hasn't been decided. *Spec: Who owns the feature once it is live, and how are live answers reviewed?* and *What is the right retention and audit policy?*

### Belongs to the platform's messaging

These are for whoever owns the platform's messaging, not this feature. *Spec: Does the platform's messaging carry messages both ways between email and the portal today, and if not, who builds it?*

- **Checks on replies sent by email (step 6).** A message written in the portal is checked before it's sent: the payer confirms it, and the same message can't go twice. A reply sent from someone's email skips the portal, so those checks don't happen, and the platform also has to be sure the email really came from the payer.
- **When a conversation is finished.** Nothing marks a conversation as finished, so there's no way to tell whether a question was ever answered, or to measure it.
