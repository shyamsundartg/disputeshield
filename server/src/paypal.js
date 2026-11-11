// Thin client for the PayPal Disputes API (v1) + OAuth.
// Docs: https://developer.paypal.com/docs/api/customer-disputes/v1/

const BASES = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export class PayPalClient {
  constructor({ clientId, clientSecret, env = 'sandbox' }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.env = env;
    this.base = BASES[env] || BASES.sandbox;
    this._token = null;
    this._tokenExp = 0;
  }

  async token() {
    if (this._token && Date.now() < this._tokenExp - 60_000) return this._token;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let res;
    try {
      res = await fetch(`${this.base}/v1/oauth2/token`, {
        signal: AbortSignal.timeout(20_000),
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
    } catch (e) {
      throw new PayPalError(`Couldn't connect to PayPal (${e.cause?.code || e.name || e.message}). Check your internet connection or VPN.`, 502, {}, true);
    }
    if (!res.ok) {
      const d = await safeJson(res);
      const hint = res.status === 401
        ? 'PayPal rejected the client ID or secret. Copy both again from the Sandbox tab of your app (not the Live tab) into server/.env, then restart.'
        : `PayPal login failed (${res.status}).`;
      throw new PayPalError(hint, res.status, d, true);
    }
    const j = await res.json();
    this._token = j.access_token;
    this._tokenExp = Date.now() + j.expires_in * 1000;
    return this._token;
  }

  async req(method, path, { json, form } = {}) {
    const headers = { Authorization: `Bearer ${await this.token()}` };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form; // FormData sets its own multipart boundary
    }
    let res;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers, body });
    } catch (e) {
      throw new PayPalError(`Couldn't connect to PayPal (${e.cause?.code || e.message}). Check your internet connection.`, 502, {}, true);
    }
    if (res.status === 204) return {};
    const data = await safeJson(res);
    if (!res.ok) {
      let hint = `PayPal returned ${res.status} for ${method} ${path.split('?')[0]}`;
      if (res.status === 403 || data?.name === 'NOT_AUTHORIZED' || data?.name === 'PERMISSION_DENIED') {
        hint = 'PayPal says this app is not allowed to use disputes. In the Developer Dashboard open your sandbox app, tick "Disputes" under features, save, then restart the server.';
      } else if (res.status === 401) {
        this._token = null;
        hint = 'PayPal rejected the access token. Restart the server; if it repeats, re-copy the sandbox keys.';
      }
      throw new PayPalError(hint, res.status, data, true);
    }
    return data;
  }

  // ---- Read ----
  async listDisputes({ pageSize = 50, state } = {}) {
    const q = new URLSearchParams({ page_size: String(pageSize) });
    if (state) q.set('dispute_state', state);
    const out = [];
    let path = `/v1/customer/disputes?${q}`;
    for (let i = 0; i < 5 && path; i++) {
      const page = await this.req('GET', path);
      out.push(...(page.items || []));
      const next = (page.links || []).find((l) => l.rel === 'next');
      path = next ? next.href.replace(this.base, '') : null;
    }
    return out;
  }

  getDispute(id) {
    return this.req('GET', `/v1/customer/disputes/${encodeURIComponent(id)}`);
  }

  // ---- Merchant actions ----

  /**
   * evidences: [{ evidence_type, evidence_info?: {tracking_info?, refund_ids?}, notes? }]
   * files: [{ name, buffer, contentType }]
   */
  provideEvidence(id, evidences, files = []) {
    const fd = new FormData();
    fd.append('input', new Blob([JSON.stringify({ evidences })], { type: 'application/json' }));
    files.forEach((f, i) => fd.append(`evidence-file${i ? i : ''}`, new Blob([f.buffer], { type: f.contentType }), f.name));
    return this.req('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, { form: fd });
  }

  acceptClaim(id, { note, accept_claim_type = 'REFUND', refund_amount } = {}) {
    const input = { note, accept_claim_type };
    if (refund_amount) input.refund_amount = refund_amount;
    const fd = new FormData();
    fd.append('input', new Blob([JSON.stringify(input)], { type: 'application/json' }));
    return this.req('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, { form: fd });
  }

  makeOffer(id, { note, offer_amount, offer_type = 'REFUND' }) {
    return this.req('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`, {
      json: { note, offer_amount, offer_type },
    });
  }

  sendMessage(id, message) {
    const fd = new FormData();
    fd.append('input', new Blob([JSON.stringify({ message })], { type: 'application/json' }));
    return this.req('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, { form: fd });
  }

  // ---- Sandbox-only helpers (for end-to-end demo) ----
  requireEvidence(id, action = 'SELLER_EVIDENCE') {
    return this.req('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/require-evidence`, { json: { action } });
  }

  adjudicate(id, adjudication_outcome) {
    return this.req('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/adjudicate`, {
      json: { adjudication_outcome },
    });
  }
}

export class PayPalError extends Error {
  constructor(msg, status, details, plain = false) {
    const extra = details?.message || details?.error_description;
    super(plain ? msg + (extra ? ` (PayPal: ${extra})` : '') : `${msg} (${status})${extra ? `: ${extra}` : ''}`);
    this.status = status;
    this.details = details;
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
