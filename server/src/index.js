import './env.js';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { runAgent, aiEnabled } from './agent.js';
import { buildEvidencePdf } from './evidencePdf.js';
import { REASON_LABELS } from './playbook.js';
import { SCENARIOS, createOrder, captureOrder, listTestPayments } from './sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Two data sources, picked per request: built-in demo data, and the live PayPal sandbox.
const hasLive = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const stores = { demo: new Store({ mode: 'demo' }) };
if (hasLive) stores.sandbox = new Store({ mode: 'paypal' });
const DEFAULT_SOURCE = hasLive && process.env.DEMO_MODE === 'false' ? 'sandbox' : 'demo';
// On the public demo the live sandbox is view-only, so judges can't use up real test disputes.
// Defaults to on when hosted on Render (which sets RENDER=true); set LIVE_READ_ONLY=false to override.
const LIVE_READ_ONLY = process.env.LIVE_READ_ONLY === 'true' || (process.env.LIVE_READ_ONLY !== 'false' && process.env.RENDER === 'true');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
  const want = req.get('x-data-source') || req.query.source;
  req.source = stores[want] ? want : DEFAULT_SOURCE;
  req.store = stores[req.source];
  next();
});
const writable = (req, res, next) => {
  if (LIVE_READ_ONLY && req.store.mode === 'paypal') {
    return res.status(403).json({ error: 'The live PayPal sandbox is view-only on this public demo. Switch to Demo data to try submitting.' });
  }
  next();
};

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message, details: e.details });
});

const OPEN = (d) => d.status !== 'RESOLVED';
const amountOf = (d) => Number(d.dispute_amount?.value || 0);

function row(store, d) {
  const a = store.analyses.get(d.dispute_id);
  const txn = d.disputed_transactions?.[0] || {};
  return {
    id: d.dispute_id,
    buyer: txn.buyer?.name || '—',
    item: txn.items?.[0]?.item_description || txn.items?.[0]?.item_name || store.contextFor(d)?.order?.items?.[0]?.title || '—',
    reason: d.reason,
    reasonLabel: REASON_LABELS[d.reason] || d.reason,
    amount: amountOf(d),
    currency: d.dispute_amount?.currency_code || 'USD',
    status: d.status,
    stage: d.dispute_life_cycle_stage,
    dueDate: d.seller_response_due_date || null,
    created: d.create_time,
    outcome: d.outcome?.outcome_code || null,
    decision: a?.decision || null,
    winProbability: a?.winProbability ?? null,
    expectedSaved: a?.economics?.expectedSaved ?? null,
    submitted: a?.submitted || null,
  };
}

// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({
    mode: req.store.mode, source: req.source, sources: Object.keys(stores), defaultSource: DEFAULT_SOURCE,
    readOnly: LIVE_READ_ONLY && req.store.mode === 'paypal', liveReadOnly: LIVE_READ_ONLY,
    ai: aiEnabled(), model: process.env.AI_MODEL || 'claude-sonnet-5-5', merchant: req.store.merchant, env: process.env.PAYPAL_ENV || 'sandbox',
  });
});

app.get('/api/disputes', wrap(async (req, res) => {
  const store = req.store;
  const list = await store.list();
  res.json(list.map((d) => row(store, d)));
}));

app.get('/api/stats', wrap(async (req, res) => {
  const store = req.store;
  const list = [...store.disputes.values()];
  const open = list.filter(OPEN);
  const resolved = list.filter((d) => !OPEN(d) && /FAVOU?R/.test(d.outcome?.outcome_code || ''));
  const won = resolved.filter((d) => /SELLER_FAVOU?R/.test(d.outcome.outcome_code));
  const soon = open.filter((d) => d.seller_response_due_date && new Date(d.seller_response_due_date) - Date.now() < 3 * 86_400_000);
  const analyzedOpen = open.map((d) => store.analyses.get(d.dispute_id)).filter(Boolean);
  res.json({
    openCount: open.length,
    atRisk: open.reduce((s, d) => s + amountOf(d), 0),
    dueSoon: soon.length,
    winRate: resolved.length ? won.length / resolved.length : null,
    recovered: won.reduce((s, d) => s + amountOf(d), 0),
    projectedSaved: analyzedOpen.reduce((s, a) => s + (a.economics?.expectedSaved || 0), 0),
    analyzed: analyzedOpen.length,
  });
}));

app.get('/api/disputes/:id', wrap(async (req, res) => {
  const store = req.store;
  const d = await store.get(req.params.id);
  res.json({
    row: row(store, d),
    dispute: d,
    context: store.contextFor(d),
    analysis: store.analyses.get(d.dispute_id) || null,
    documents: (store.documents.get(d.dispute_id) || []).map((f) => ({ name: f.name, size: f.buffer.length })),
    activity: store.activity.filter((a) => a.disputeId === d.dispute_id),
  });
}));

// Live agent run, streamed as Server-Sent Events.
app.get('/api/disputes/:id/analyze', wrap(async (req, res) => {
  const store = req.store;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const d = await store.get(req.params.id);
    const result = await runAgent({
      dispute: d, ctx: store.contextFor(d), merchant: store.merchant,
      onStep: (s) => send('step', s), pace: req.query.fast ? 0 : 450,
    });
    store.analyses.set(d.dispute_id, result);
    store.log(d.dispute_id, 'ANALYZED', `${result.decision} · ${Math.round(result.winProbability * 100)}% win chance`);
    send('result', result);
  } catch (e) {
    send('error', { error: e.message });
  }
  res.end();
}));

// Triage every open dispute at once (autopilot).
app.post('/api/triage', wrap(async (req, res) => {
  const store = req.store;
  const open = (await store.list()).filter(OPEN).filter((d) => !store.analyses.has(d.dispute_id));
  const results = await Promise.all(open.map(async (d) => {
    const r = await runAgent({ dispute: d, ctx: store.contextFor(d), merchant: store.merchant, pace: 0 });
    store.analyses.set(d.dispute_id, r);
    store.log(d.dispute_id, 'ANALYZED', `${r.decision} · ${Math.round(r.winProbability * 100)}% win chance`);
    return d.dispute_id;
  }));
  res.json({ analyzed: results });
}));

// Merchant edits to the draft before submitting.
app.patch('/api/disputes/:id/draft', wrap(async (req, res) => {
  const store = req.store;
  const a = store.analyses.get(req.params.id);
  if (!a) return res.status(400).json({ error: 'Analyze first' });
  if (req.body.response_notes != null) {
    a.draft.response_notes = String(req.body.response_notes).slice(0, 2000);
    if (a.evidences[0]) a.evidences[0].notes = a.draft.response_notes;
  }
  if (req.body.decision) a.decision = req.body.decision;
  res.json(a);
}));

app.post('/api/disputes/:id/documents', writable, upload.array('files', 5), wrap(async (req, res) => {
  const store = req.store;
  const list = store.documents.get(req.params.id) || [];
  for (const f of req.files || []) list.push({ name: f.originalname, buffer: f.buffer, contentType: f.mimetype });
  store.documents.set(req.params.id, list);
  store.log(req.params.id, 'DOCUMENT_ADDED', (req.files || []).map((f) => f.originalname).join(', '));
  res.json({ documents: list.map((f) => ({ name: f.name, size: f.buffer.length })) });
}));

app.get('/api/disputes/:id/evidence.pdf', wrap(async (req, res) => {
  const store = req.store;
  const d = await store.get(req.params.id);
  const a = store.analyses.get(d.dispute_id);
  if (!a) return res.status(400).json({ error: 'Analyze first' });
  const pdf = await buildEvidencePdf({ dispute: d, ctx: store.contextFor(d), merchant: store.merchant, result: a });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="evidence-${d.dispute_id}.pdf"`);
  res.send(pdf);
}));

// Execute the merchant-approved decision against PayPal.
app.post('/api/disputes/:id/submit', writable, wrap(async (req, res) => {
  const store = req.store;
  const d = await store.get(req.params.id);
  const a = store.analyses.get(d.dispute_id);
  if (!a) return res.status(400).json({ error: 'Analyze first' });
  const action = req.body.action || a.decision;
  const currency = d.dispute_amount.currency_code;
  let detail;

  if (action === 'FIGHT') {
    const pdf = await buildEvidencePdf({ dispute: d, ctx: store.contextFor(d), merchant: store.merchant, result: a });
    const files = [{ name: `evidence-${d.dispute_id}.pdf`, buffer: pdf, contentType: 'application/pdf' }, ...(store.documents.get(d.dispute_id) || [])];
    if (store.mode === 'paypal') await store.paypal.provideEvidence(d.dispute_id, a.evidences, files);
    else store.mockUpdate(d.dispute_id, { status: 'UNDER_REVIEW' });
    detail = `Evidence submitted: ${a.evidences.map((e) => e.evidence_type).join(', ')} + ${files.length} file(s)`;
  } else if (action === 'OFFER') {
    const value = (req.body.offerAmount ?? a.offer?.amount ?? 0).toFixed(2);
    const note = req.body.note || a.draft.buyer_message || 'Partial refund offered to resolve.';
    if (store.mode === 'paypal') await store.paypal.makeOffer(d.dispute_id, { note, offer_amount: { currency_code: currency, value }, offer_type: 'REFUND' });
    else store.mockUpdate(d.dispute_id, { status: 'WAITING_FOR_BUYER_RESPONSE', offer: { buyer_requested_amount: d.dispute_amount, seller_offered_amount: { currency_code: currency, value } } });
    detail = `Offered partial refund of ${currency} ${value}`;
  } else if (action === 'ACCEPT') {
    const note = req.body.note || 'Accepting claim and refunding the buyer.';
    if (store.mode === 'paypal') await store.paypal.acceptClaim(d.dispute_id, { note, accept_claim_type: 'REFUND' });
    else store.mockUpdate(d.dispute_id, { status: 'RESOLVED', outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: d.dispute_amount } });
    detail = `Accepted claim — refunded ${currency} ${d.dispute_amount.value}`;
  } else {
    return res.status(400).json({ error: 'action must be FIGHT, OFFER or ACCEPT' });
  }

  a.submitted = { action, at: new Date().toISOString() };
  store.log(d.dispute_id, `SUBMITTED_${action}`, detail);
  res.json({ ok: true, detail, row: row(store, store.disputes.get(d.dispute_id)) });
}));

// Sandbox / demo helper: let "PayPal" decide the case so the demo can end.
app.post('/api/disputes/:id/simulate-decision', writable, wrap(async (req, res) => {
  const store = req.store;
  const d = await store.get(req.params.id);
  const a = store.analyses.get(d.dispute_id);
  const outcome = req.body.outcome || ((a?.winProbability ?? 0.5) >= 0.5 ? 'SELLER_FAVOR' : 'BUYER_FAVOR');
  if (store.mode === 'paypal') {
    await store.paypal.adjudicate(d.dispute_id, outcome);
  } else {
    if (d.status === 'WAITING_FOR_BUYER_RESPONSE' && d.offer) {
      store.mockUpdate(d.dispute_id, { status: 'RESOLVED', outcome: { outcome_code: 'RESOLVED_WITH_PAYOUT', amount_refunded: d.offer.seller_offered_amount } });
    } else {
      store.mockUpdate(d.dispute_id, { status: 'RESOLVED', outcome: { outcome_code: outcome === 'SELLER_FAVOR' ? 'RESOLVED_SELLER_FAVOUR' : 'RESOLVED_BUYER_FAVOUR' } });
    }
  }
  store.log(d.dispute_id, 'DECIDED', outcome);
  res.json({ ok: true, row: row(store, store.disputes.get(d.dispute_id)) });
}));

// Sandbox helper: move a dispute from UNDER_REVIEW to waiting-for-seller.
app.post('/api/disputes/:id/require-evidence', writable, wrap(async (req, res) => {
  const store = req.store;
  if (store.mode !== 'paypal') return res.json({ ok: true, note: 'demo mode — nothing to do' });
  await store.paypal.requireEvidence(req.params.id, 'SELLER_EVIDENCE');
  res.json({ ok: true });
}));

app.post('/api/demo/reset', (req, res) => {
  stores.demo.resetDemo();
  res.json({ ok: true });
});

app.get('/api/activity', (req, res) => res.json(req.store.activity));

// ---------- Sandbox test data ----------
const needSandbox = (res) => {
  if (!stores.sandbox) { res.status(400).json({ error: 'Test payments need PayPal sandbox keys in server/.env.' }); return false; }
  if (LIVE_READ_ONLY) { res.status(403).json({ error: 'Test payments are turned off on the public demo.' }); return false; }
  if ((process.env.PAYPAL_ENV || 'sandbox') !== 'sandbox') { res.status(400).json({ error: 'Test payments only work in the PayPal sandbox.' }); return false; }
  return true;
};

app.get('/api/sandbox/scenarios', (req, res) => {
  res.json({ scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, label: s.label, price: s.product.price, item: s.product.title })), payments: stores.sandbox ? listTestPayments(stores.sandbox) : [] });
});

app.post('/api/sandbox/test-payment', writable, wrap(async (req, res) => {
  const store = req.store;
  if (!needSandbox(res)) return;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json(await createOrder(stores.sandbox.paypal, { scenario: req.body?.scenario, baseUrl }));
}));

// PayPal sends the buyer back here after they approve the payment.
app.get('/api/sandbox/return', wrap(async (req, res) => {
  const store = req.store;
  if (!needSandbox(res)) return;
  const back = process.env.WEB_URL || '/';
  try {
    const r = await captureOrder(stores.sandbox.paypal, stores.sandbox, req.query.token);
    res.redirect(`${back}?source=sandbox&sandbox=paid&txn=${encodeURIComponent(r.transactionId)}`);
  } catch (e) {
    res.redirect(`${back}?sandbox=error&msg=${encodeURIComponent(e.message)}`);
  }
}));

// PayPal webhook: auto-analyze new disputes the moment they arrive.
// Subscribe your app to CUSTOMER.DISPUTE.CREATED / CUSTOMER.DISPUTE.UPDATED.
app.post('/api/webhooks/paypal', wrap(async (req, res) => {
  const store = req.store;
  const ev = req.body || {};
  const id = ev.resource?.dispute_id;
  res.json({ received: true });
  if (!stores.sandbox) return;
  const live = stores.sandbox;
  if (!id || !/CUSTOMER\.DISPUTE\.(CREATED|UPDATED)/.test(ev.event_type || '')) return;
  if (process.env.PAYPAL_WEBHOOK_ID && !(await verifyWebhook(req))) {
    console.warn('Webhook signature verification failed');
    return;
  }
  const d = await live.get(id);
  const r = await runAgent({ dispute: d, ctx: live.contextFor(d), merchant: live.merchant, pace: 0 });
  live.analyses.set(id, r);
  live.log(id, 'AUTO_ANALYZED', `Webhook ${ev.event_type} → ${r.decision}`);
}));

async function verifyWebhook(req) {
  const h = req.headers;
  const body = {
    auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
    transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: req.body,
  };
  const r = await stores.sandbox.paypal.req('POST', '/v1/notifications/verify-webhook-signature', { json: body });
  return r.verification_status === 'SUCCESS';
}

// ---------- Static frontend ----------
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => {
  console.log(`DisputeShield API on http://localhost:${PORT} · sources=${Object.keys(stores).join('+')} (default ${DEFAULT_SOURCE})${LIVE_READ_ONLY ? ' · live view-only' : ''} · ai=${aiEnabled() ? 'on' : 'template'}`);
});
