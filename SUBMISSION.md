# Devpost submission (paste-ready)

## Project name
DisputeShield

## Elevator pitch
An AI agent for small PayPal merchants: it builds the evidence for every dispute and tells you whether to fight, offer a partial refund, or refund, then does it in one click.

## Try it out (links)
- Live demo: https://disputeshield-px8o.onrender.com/
- Code: https://github.com/shyamsundartg/disputeshield

## Video demo link
_Paste the YouTube link here (set to Public)._

## Built with
paypal-disputes-api, paypal-orders-api, paypal-webhooks, claude, anthropic, ag-grid, react, node.js, express, vite, render

---

## About the project

### Inspiration
We build software for small businesses in Chennai, and many of them sell abroad through PayPal: handloom, crafts, small D2C brands. A single dispute can wipe out the margin on a month of orders. Sellers lose cases they should win because they don't know what evidence PayPal needs, or they miss the deadline. They also fight cases they should simply refund, and pay a dispute fee on top. We wanted an agent that does what a good dispute specialist would: gather the facts, be honest about the odds, and act.

### What it does
DisputeShield reads each dispute from the PayPal Disputes API and builds the case live, step by step:

- **Finds the evidence.** It matches the PayPal transaction to the store order, then pulls courier tracking, delivery and signature, refunds already issued, and the customer conversation.
- **Checks it against what PayPal needs** for that claim type. "Item not received" needs carrier, tracking and proof of delivery. "Duplicate charge" needs a refund ID. "Not as described" needs the listing and the return policy.
- **Recommends fight, partial refund, or refund, with the money behind it.** It compares the expected loss of fighting (the chance of losing times the amount, plus the dispute fee) with the cost of a partial refund and a full refund.
- **Is honest.** If the merchant received a return and never refunded, it says the buyer is right and recommends refunding, because fighting unwinnable cases hurts the seller's account.
- **Drafts the response** that PayPal's reviewer reads, plus an evidence-pack PDF, for the merchant to edit.
- **Acts in one click** through PayPal: provide-evidence with typed proof (tracking as proof of fulfillment, refund IDs as proof of refund), make-offer, or accept-claim.
- **Triages the whole queue** at once in an AG Grid dashboard: money at risk, deadlines, recommendation and win chance for every case, with an audit trail.

We ran it on real PayPal sandbox disputes. For a $34 "item not received" claim, it matched the dispute to its order, found signed DHL delivery to the buyer's PayPal address, recommended fighting at a 90% win chance, and submitted the evidence through the Disputes API. PayPal then moved the case to review.

### How we built it
- **PayPal:** the Disputes API for listing disputes, reading details, provide-evidence (multipart, with the evidence PDF), make-offer and accept-claim; sandbox-only adjudicate and require-evidence to complete the loop; the Orders API for a built-in test-payment flow; and a webhook receiver for new disputes.
- **Agent:** a deterministic playbook per dispute reason decides the call from facts it can verify. Claude writes the explanation, the reviewer statement and a buyer message through a forced tool call, so the reply is always structured. It is told never to invent tracking events, dates or documents. Without an AI key, a template writer takes over.
- **App:** Node.js and Express backend with live agent steps streamed to the browser over Server-Sent Events; React frontend with AG Grid for the case list; deployed on Render's free plan.
- **Two data sources:** built-in demo cases (a Chennai handloom exporter with six disputes covering every outcome) and the live PayPal sandbox, switchable in the header. On the public demo the live view is read-only, so visitors can run the agent on real disputes without changing them.

### Challenges we ran into
- **Matching disputes to orders.** Sandbox disputes didn't always reference the payment by the same ID we saved at checkout, so early runs found no evidence and wrongly said "refund". We now match on every ID PayPal returns, then the invoice, then amount and item name.
- **Reliable AI output.** Parsing JSON out of free text sometimes failed, so we moved to a forced tool call with a schema.
- **A safe public demo.** Judges share one hosted copy, so live sandbox actions are view-only there while the demo data stays fully interactive and resettable.

### Accomplishments that we're proud of
- An end-to-end run on real PayPal sandbox disputes: evidence submitted through the Disputes API, not just a mockup.
- The agent recommends refunding when the buyer is right, instead of always telling the merchant to fight.
- Every recommendation shows its evidence checklist and its cost, so the merchant can see why.

### What we learned
What wins a dispute is specific and checkable: tracking, delivery scans, signatures, refund IDs. Rules should make the decision from those facts, and the AI is best used to explain it and write it up. Keeping the two separate made the agent more trustworthy and easier to debug.

### What's next for DisputeShield
- PayPal partner onboarding so any merchant can connect their account in one click.
- Store and courier connectors (Shopify, WooCommerce, India Post, DHL) instead of a data file.
- Learning win chances from each merchant's resolved disputes, rather than rules alone.
- Deadline reminders, so no response is ever missed.

---

## Testing instructions for judges
No login needed. Open the live demo, click any case, then **Build the case**. Demo data is preloaded; use **Reset demo** to start fresh. Switch to **Live PayPal sandbox** in the header to see real sandbox disputes (view-only, so every judge sees the same cases). The demo is hosted on Render's free plan, so the first load may take up to a minute. To run it against your own PayPal sandbox, see the README.

## Sponsor prize
AG Grid
