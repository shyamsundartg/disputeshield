// Deterministic dispute playbook: what PayPal needs for each dispute reason,
// which of it the merchant actually has, a win-probability estimate, and
// the money math of fighting vs refunding. The LLM writes on top of this;
// it never invents the facts.

const DAY = 86_400_000;
const days = (a, b = Date.now()) => Math.round((new Date(b) - new Date(a)) / DAY);

export const REASON_LABELS = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorized transaction',
  CREDIT_NOT_PROCESSED: 'Refund not processed',
  DUPLICATE_TRANSACTION: 'Duplicate charge',
  INCORRECT_AMOUNT: 'Incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'Paid by other means',
  CANCELED_RECURRING_BILLING: 'Cancelled subscription',
  PROBLEM_WITH_REMITTANCE: 'Remittance problem',
  OTHER: 'Other',
};

/**
 * @returns {{
 *   signals: {label:string, ok:boolean, weight:number, detail:string}[],
 *   checklist: {item:string, have:boolean, detail:string}[],
 *   winProbability:number, evidences:object[], decision:string,
 *   economics:object, honestyFlag:string|null, offer?:object
 * }}
 */
export function analyzeCase(dispute, ctx, merchant) {
  const amount = Number(dispute.dispute_amount?.value || 0);
  const reason = dispute.reason;
  const signals = [];
  const checklist = [];
  const evidences = [];
  let p = 0.3;
  let honestyFlag = null;
  const sig = (label, ok, weight, detail) => {
    signals.push({ label, ok, weight, detail });
    p += ok ? weight : -Math.abs(weight) / 2;
  };
  const need = (item, have, detail) => checklist.push({ item, have: !!have, detail });

  const ship = ctx?.shipping;
  const delivered = !!ship?.delivered;
  const tracking = ship?.tracking_number;
  const addrMatch = ctx?.order && ctx.order.ship_to === ctx.order.bill_to;
  const refunds = ctx?.refunds || [];

  const fulfillmentEvidence = () => {
    const code = carrierCode(ship.carrier);
    const t = { carrier_name: code, tracking_number: tracking };
    if (code === 'OTHER') t.carrier_name_other = ship.carrier;
    evidences.push({ evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [t] } });
  };

  switch (reason) {
    case 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED': {
      p = 0.25;
      need('Carrier + tracking number', tracking, tracking ? `${ship.carrier} ${tracking}` : 'No tracking on file');
      need('Delivery confirmation', delivered, delivered ? `Delivered ${fmt(ship.delivered)}` : 'Carrier shows no delivery scan');
      need('Signature on delivery', ship?.signed_by, ship?.signed_by ? `Signed by ${ship.signed_by}` : 'No signature');
      need('Shipped to PayPal address', addrMatch, !ctx?.order ? 'No store order linked' : addrMatch ? 'Ship-to matches billing' : 'Address mismatch');
      if (tracking) sig('Valid tracking number', true, 0.1, `${ship.carrier} ${tracking}`);
      sig('Carrier confirms delivery', delivered, 0.35, delivered ? `${days(ship.delivered)} days before dispute` : `Last scan: "${ship?.events?.at(-1)?.[0] ?? 'none'}"`);
      if (ship?.signed_by) sig('Signed proof of delivery', true, 0.15, ship.signed_by);
      if (addrMatch) sig('Delivered to verified address', true, 0.05, ctx.order.ship_to);
      if (!delivered && ship?.shipped && days(ship.shipped) > 21) {
        honestyFlag = `Parcel has been in transit ${days(ship.shipped)} days with no delivery scan — PayPal will side with the buyer.`;
      }
      if (tracking) fulfillmentEvidence();
      break;
    }
    case 'UNAUTHORISED': {
      p = 0.25;
      const r = ctx?.risk || {};
      need('Proof of delivery', delivered, delivered ? `${ship.carrier} ${tracking}, delivered ${fmt(ship.delivered)}` : 'Not delivered');
      need('Billing/shipping address match (AVS)', r.avs_match ?? addrMatch, r.avs_match ? 'AVS match' : '—');
      need('Customer history', ctx?.customer?.previous_orders > 0, `${ctx?.customer?.previous_orders ?? 0} previous orders`);
      need('Device / IP consistency', r.device_seen_before, r.device_seen_before ? `Known device, IP ${r.ip_city}` : 'No device data');
      sig('Delivered with signature', delivered && !!ship.signed_by, 0.2, ship?.signed_by || '');
      sig('Ship-to matches billing address', !!addrMatch, 0.1, ctx?.order?.ship_to || '');
      sig('Returning customer', ctx?.customer?.previous_orders > 0, 0.15, `${ctx?.customer?.previous_orders ?? 0} prior paid orders, no disputes`);
      sig('Same device & IP region as past orders', !!r.device_seen_before, 0.1, r.ip_city || '');
      const buyerNote = (ctx?.comms || []).find(([w]) => w === 'CUSTOMER');
      if (buyerNote) sig('Buyer messaged about this order', true, 0.1, `"${buyerNote[2]}"`);
      if (tracking) fulfillmentEvidence();
      break;
    }
    case 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED': {
      p = 0.3;
      const item = ctx?.order?.items?.[0] || {};
      const disclaimer = /vary|variation/i.test(item.description || '') || /variation/i.test(merchant.return_policy);
      const praise = (ctx?.comms || []).find(([w, , t]) => w === 'CUSTOMER' && /quality|lovely|beautiful|love/i.test(t));
      need('Listing description', item.description, item.description || 'Not captured');
      need('Colour-variation disclaimer', disclaimer, disclaimer ? 'Listing + policy disclose natural dye variation' : 'None');
      need('Return policy offered', true, '14-day returns');
      need('Photos of item shipped', false, 'Not on file — ask packing team');
      sig('Listing discloses colour variation', disclaimer, 0.15, item.description || '');
      sig('Buyer acknowledged quality in writing', !!praise, 0.1, praise ? `"${praise[2]}"` : '');
      sig('Return offered before dispute', (ctx?.comms || []).some(([w, , t]) => w === 'MERCHANT' && /return/i.test(t)), 0.1, '');
      sig('Packing photos available', false, 0.1, 'Missing');
      evidences.push({ evidence_type: 'OTHER', notes: '' });
      break;
    }
    case 'DUPLICATE_TRANSACTION':
    case 'INCORRECT_AMOUNT':
    case 'PAYMENT_BY_OTHER_MEANS': {
      p = 0.2;
      const ref = refunds[0];
      need('Refund ID for the extra charge', ref, ref ? `${ref.refund_id} — $${ref.amount} on ${fmt(ref.time)}` : 'No refund found');
      need('Message telling buyer about refund', (ctx?.comms || []).some(([w]) => w === 'MERCHANT'), '');
      sig('Duplicate already refunded', !!ref, 0.65, ref?.refund_id || '');
      if (ref) evidences.push({ evidence_type: 'PROOF_OF_REFUND', evidence_info: { refund_ids: [ref.refund_id] } });
      break;
    }
    case 'CREDIT_NOT_PROCESSED': {
      p = 0.2;
      const ref = refunds[0];
      const ret = ctx?.return;
      need('Refund ID', ref, ref ? ref.refund_id : 'No refund issued');
      need('Return received?', ret?.received, ret?.received ? `Return ${ret.tracking_number} received ${fmt(ret.received)}` : 'No');
      sig('Refund already issued', !!ref, 0.65, ref?.refund_id || 'none');
      if (ref) evidences.push({ evidence_type: 'PROOF_OF_REFUND', evidence_info: { refund_ids: [ref.refund_id] } });
      if (!ref && ret?.received) {
        p = 0.03;
        honestyFlag = `You received the return ${days(ret.received)} days ago and haven't refunded. The buyer is right — refund now to protect your seller metrics.`;
      }
      break;
    }
    default: {
      need('Supporting documents', false, 'Upload invoice or contract');
      evidences.push({ evidence_type: 'OTHER', notes: '' });
    }
  }

  p = clamp(p, 0.02, 0.95);
  if (honestyFlag) p = Math.min(p, 0.08);

  // ---- Money math ----
  const fee = merchant.dispute_fee_usd ?? 15;
  const itemCost = (ctx?.order?.items || []).reduce((s, i) => s + (i.cost || 0), 0);
  const expectedLossFight = round((1 - p) * (amount + fee));
  const refundLoss = round(amount);
  const isInquiry = dispute.dispute_life_cycle_stage === 'INQUIRY';
  let offer = null;
  if (reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') {
    const pct = 0.25;
    offer = { pct, amount: round(amount * pct), note: `Partial refund of ${pct * 100}% — buyer keeps the item. Cheaper than a $${ctx?.return_shipping_estimate ?? 25} international return.` };
  }

  let decision;
  if (honestyFlag) decision = 'ACCEPT';
  else if (offer && isInquiry && p < 0.7) decision = 'OFFER';
  else if (p >= 0.5 && expectedLossFight < refundLoss) decision = 'FIGHT';
  else if (offer && isInquiry) decision = 'OFFER';
  else decision = 'ACCEPT';

  const decisionLoss = decision === 'FIGHT' ? expectedLossFight : decision === 'OFFER' ? offer.amount : refundLoss;
  const economics = {
    amount, fee, itemCost,
    expectedLossFight, refundLoss,
    offerCost: offer?.amount ?? null,
    expectedSaved: round(Math.max(0, refundLoss - decisionLoss)),
  };

  return { signals, checklist, winProbability: round(p, 2), evidences, decision, economics, honestyFlag, offer };
}

function carrierCode(name = '') {
  const n = name.toUpperCase();
  if (n.includes('DHL')) return 'DHL';
  if (n.includes('FEDEX')) return 'FEDEX';
  if (n.includes('UPS')) return 'UPS';
  if (n.includes('USPS')) return 'USPS';
  return 'OTHER';
}

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
export const fmt = (d) => new Date(d).toISOString().slice(0, 10);
