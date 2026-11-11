// Data access: either the live PayPal sandbox or the built-in demo data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PayPalClient } from './paypal.js';
import { buildMockDisputes, MERCHANT_CONTEXT, MERCHANT } from './mockData.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

export class Store {
  constructor() {
    const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV, DEMO_MODE } = process.env;
    this.mode = PAYPAL_CLIENT_ID && PAYPAL_CLIENT_SECRET && DEMO_MODE !== 'true' ? 'paypal' : 'demo';
    this.paypal = this.mode === 'paypal' ? new PayPalClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET, env: PAYPAL_ENV || 'sandbox' }) : null;
    this.merchant = { ...MERCHANT, ...loadJson('merchant.json') };
    // Merchant context (orders, tracking, chats, refunds) keyed by PayPal seller_transaction_id.
    this.context = this.mode === 'demo' ? MERCHANT_CONTEXT : loadJson('merchant-context.json') || {};
    this.disputes = new Map(); // id -> dispute
    this.analyses = new Map(); // id -> agent result
    this.documents = new Map(); // id -> [{name, buffer, contentType}]
    this.activity = []; // audit log
    if (this.mode === 'demo') this.resetDemo();
  }

  resetDemo() {
    this.disputes = new Map(buildMockDisputes().map((d) => [d.dispute_id, d]));
    this.analyses.clear();
    this.documents.clear();
    this.activity = [];
  }

  log(disputeId, action, detail) {
    this.activity.unshift({ at: new Date().toISOString(), disputeId, action, detail });
    this.activity = this.activity.slice(0, 200);
  }

  async list() {
    if (this.mode === 'paypal') {
      const items = await this.paypal.listDisputes();
      // Summary list lacks transactions/messages; fetch full details (bounded).
      const full = await Promise.all(
        items.slice(0, 40).map((s) => this.paypal.getDispute(s.dispute_id).catch(() => s)),
      );
      full.forEach((d) => this.disputes.set(d.dispute_id, d));
    }
    return [...this.disputes.values()];
  }

  async get(id) {
    if (this.mode === 'paypal') {
      const d = await this.paypal.getDispute(id);
      this.disputes.set(id, d);
      return d;
    }
    const d = this.disputes.get(id);
    if (!d) throw Object.assign(new Error('Dispute not found'), { status: 404 });
    return d;
  }

  contextFor(dispute) {
    const txn = dispute.disputed_transactions?.[0];
    return this.context[txn?.seller_transaction_id] || this.context[txn?.invoice_number] || null;
  }

  // ---- Mock state transitions (demo mode mirrors PayPal's lifecycle) ----
  mockUpdate(id, patch) {
    const d = this.disputes.get(id);
    Object.assign(d, patch, { update_time: new Date().toISOString() });
    return d;
  }
}

function loadJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}
