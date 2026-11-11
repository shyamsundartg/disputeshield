# DisputeShield

An AI agent that defends small PayPal merchants against disputes.

Small sellers lose disputes they should win, because they don't know what evidence PayPal wants or they miss the deadline. They also fight disputes they should just refund, and pay the fee on top. DisputeShield reads each PayPal dispute and pulls in the order, courier tracking, refunds and customer messages. It checks those against what PayPal needs for that claim type, then recommends **fight**, **offer a partial refund**, or **refund**, with the money math behind the call. One click executes the decision through the PayPal Disputes API.

Built by WorkAxis (Chennai) for the PayPal AI Hackathon 2026.

## What it does

- **Live case builder.** The agent's steps stream into the UI: it reads the dispute, matches the transaction to a store order, checks tracking, reads the conversation, scores the case and drafts the response.
- **Evidence checklist per claim type.** "Item not received" needs carrier, tracking and delivery proof. "Duplicate charge" needs a refund ID. "Not as described" needs the listing and policy, and so on.
- **Fight vs offer vs refund economics.** Expected loss if you fight (win chance × amount + dispute fee) is compared with the cost of a partial refund and a full refund.
- **Honest by design.** If the buyer is right (for example, the merchant received the return and never refunded), the agent says so and recommends refunding. Fighting unwinnable cases hurts seller metrics.
- **One-click execution on PayPal:**
  - Fight → `POST /v1/customer/disputes/{id}/provide-evidence` with typed evidence (`PROOF_OF_FULFILLMENT` with tracking, `PROOF_OF_REFUND` with refund IDs) plus a generated evidence-pack PDF and any photos the merchant adds.
  - Offer → `POST …/make-offer` (inquiry stage).
  - Refund → `POST …/accept-claim`.
- **Autopilot.** A webhook (`CUSTOMER.DISPUTE.CREATED` / `UPDATED`) analyzes new disputes the moment PayPal sends them, and "Analyze all open cases" triages the whole queue.
- **AG Grid dashboard.** Money at risk, deadlines, recommendations and win chance for every case.
- **Audit trail.** Every analysis and action is logged per case.
- **Demo / Live PayPal sandbox switch.** With PayPal keys set, the header lets you flip between the built-in demo cases and real disputes in the PayPal sandbox. On the public demo the live view is read-only (`LIVE_READ_ONLY`), so visitors can run the agent but can't change the sandbox.

## Run it

Requires Node 20+.

```bash
npm run setup          # installs server + web
cp server/.env.example server/.env
npm start              # builds the web app and serves everything on http://localhost:8787
```

With no keys in `.env`, it runs on built-in demo data: "Kanchi Looms", a Chennai handloom exporter with 6 open disputes and 3 closed ones. Every flow works end to end.

For development with hot reload, run `npm run dev:server` and `npm run dev:web`, then open http://localhost:5173.

### Turn on AI drafting

Set `ANTHROPIC_API_KEY` in `server/.env`. Without it, a deterministic template writes the response. With it, Claude writes the reviewer-facing statement, the reasoning, a buyer message and the risk list. Claude only works from the facts the playbook gathered; it is told never to invent tracking events, dates or documents.

### Connect the PayPal sandbox

1. In the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/), open your sandbox app and enable **Disputes** under feature options. Copy the client ID and secret into `server/.env`.
2. Create a dispute to work on. Pay your sandbox business account from a sandbox personal account (any checkout or invoice). Then log in to sandbox.paypal.com as the buyer and open a dispute from the Resolution Center.
3. Copy `server/data/merchant-context.example.json` to `merchant-context.json` and key it by the sandbox transaction ID. This is the store order, tracking and messages the agent will use.
4. Restart. The header switches from "Demo data" to "PayPal sandbox".
5. If a dispute sits in `UNDER_REVIEW`, call `POST /api/disputes/{id}/require-evidence` to move it to "waiting for seller". After submitting, "Simulate PayPal's decision" calls the sandbox-only `adjudicate` endpoint, so you can show the full loop.
6. Optional: point a sandbox webhook at `https://<your-host>/api/webhooks/paypal` for the `CUSTOMER.DISPUTE.*` events and set `PAYPAL_WEBHOOK_ID`.

## Deploy (free)

The repo includes a `render.yaml` blueprint. On [Render](https://render.com), choose **New → Blueprint**, pick this repo and click **Apply**. It deploys on the free plan and opens on demo data. To also show your live sandbox disputes, add `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` under the service's **Environment** tab; the live view stays read-only for visitors. Free services sleep when idle, so the first visit after a quiet period can take up to a minute to load.

## How it's built

```
web/      React + AG Grid (Community). Vite build is served by the API.
server/
  src/paypal.js       OAuth + Disputes API client (list, get, provide-evidence, make-offer,
                      accept-claim, send-message, sandbox require-evidence / adjudicate)
  src/store.js        Demo vs PayPal mode, merchant context lookup, audit log
  src/playbook.js     Per-reason evidence rules, win-probability scoring, fight/offer/refund math
  src/agent.js        Orchestrates the run, streams steps, Claude drafting with template fallback
  src/evidencePdf.js  Evidence pack PDF attached to provide-evidence
  src/index.js        REST + SSE endpoints, webhook receiver, static hosting
```

The scoring is deliberately split. The playbook makes the call from facts it can verify; the LLM explains and writes. That keeps recommendations explainable and stops the model from talking a merchant into a fight they'll lose.

## Honest limits

- Win chance is a rules-based estimate from PayPal's published evidence requirements. It is not trained on outcome data yet. Learning from each merchant's resolved disputes is the next step.
- The dispute fee is configurable (`dispute_fee_usd`). Check the current PayPal fee for your account.
- In live mode, store data comes from a JSON file. Real connectors (Shopify, WooCommerce, courier APIs, Gmail) are the obvious next build.
