# Demo video script (about 2 minutes)

Record at 1440×900 with `DEMO_MODE=true` and an `ANTHROPIC_API_KEY` set. Click **Reset demo** before each take.

**0:00–0:15. The problem.** Open on the dashboard.
"This is Kanchi Looms, a handloom exporter in Chennai. They have $1,166 tied up in six PayPal disputes, and two are due in the next three days. Small sellers lose these because they don't know what evidence PayPal wants, or they fight cases they should just refund."

**0:15–0:50. Build a case live.** Click PP-D-48213 ($340, item not received), then click **Build the case**.
"The agent reads the dispute from PayPal, finds the order in the store, checks DHL tracking, reads the customer conversation, and matches all of it to what PayPal requires for a not-received claim."
When the verdict lands: "Signed delivery to the billing address, four out of four items. 90% win chance. Fighting costs about $35 in expected loss against $340 to refund."

**0:50–1:10. One click to PayPal.** Scroll to the drafted response, edit a word to show it's editable, open the evidence pack PDF, then click **Submit evidence to PayPal**.
"That calls PayPal's provide-evidence API with the tracking as typed proof of fulfillment, plus this evidence pack."

**1:10–1:35. It's honest.** Click **Analyze all open cases**, then open PP-D-48241 ($60, refund not processed).
"Not every case should be fought. Here the merchant received the return and never refunded. The agent says the buyer is right and recommends refunding, because fighting this hurts the seller's account."
Open PP-D-48219 (not as described): "And here a 25% partial refund beats both fighting and a costly international return."

**1:35–1:55. Close the loop.** Back on PP-D-48213, click **Simulate PayPal's decision** (sandbox adjudicate). Show "Won" in the grid and the win rate updating.
"New disputes arrive by webhook and are analyzed before the merchant even opens the app."

**1:55–2:00.** "DisputeShield: keep the money you earned, and refund the money you owe."

## Devpost submission

The full paste-ready Devpost text (pitch, description, links, testing notes) is in [SUBMISSION.md](SUBMISSION.md).
