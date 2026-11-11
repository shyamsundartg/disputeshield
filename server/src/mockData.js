// Demo data for "Kanchi Looms", a small Chennai handloom exporter selling
// to the US/UK through PayPal. Disputes are shaped like real PayPal
// Disputes API responses; merchant context (orders, tracking, chats,
// refunds) is what the agent would pull from the store, courier and inbox.
// Dates are relative to "now" so deadlines always look live in a demo.

const DAY = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const money = (v) => ({ currency_code: 'USD', value: v.toFixed(2) });

export const MERCHANT = {
  name: 'Kanchi Looms',
  location: 'Chennai, India',
  return_policy:
    'Returns accepted within 14 days of delivery for unused items in original packaging. ' +
    'Handwoven silk has natural colour variation; slight differences from photos are not a defect. ' +
    'Refunds issued within 5 business days of receiving the return.',
  dispute_fee_usd: 15,
};

function dispute(o) {
  return {
    dispute_id: o.id,
    create_time: iso(o.created),
    update_time: iso(o.updated ?? o.created),
    reason: o.reason,
    status: o.status,
    dispute_state: o.status === 'RESOLVED' ? 'RESOLVED' : 'REQUIRED_ACTION',
    dispute_amount: money(o.amount),
    dispute_life_cycle_stage: o.stage || 'CHARGEBACK',
    dispute_channel: o.channel || 'INTERNAL',
    seller_response_due_date: o.due != null ? iso(o.due) : undefined,
    disputed_transactions: [
      {
        seller_transaction_id: o.txn,
        buyer_transaction_id: 'B' + o.txn.slice(1),
        create_time: iso(o.created - 20),
        transaction_status: 'COMPLETED',
        gross_amount: money(o.amount),
        invoice_number: o.invoice,
        buyer: { name: o.buyer },
        items: o.items.map((d, i) => ({ item_id: `SKU-${o.invoice}-${i}`, item_description: d, item_quantity: '1' })),
      },
    ],
    messages: (o.messages || []).map(([who, d, content]) => ({ posted_by: who, time_posted: iso(d), content })),
    outcome: o.outcome ? { outcome_code: o.outcome, amount_refunded: o.outcome === 'RESOLVED_BUYER_FAVOUR' ? money(o.amount) : money(0) } : undefined,
    links: [],
  };
}

export function buildMockDisputes() {
  return [
    dispute({
      id: 'PP-D-48213', txn: '7XK21934AB102233L', invoice: 'KL-1042', buyer: 'Jennifer M.',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 340, created: -3, due: 7, items: ['Kanchipuram pure silk saree – peacock blue, zari border'],
      messages: [['BUYER', -3, 'I never received my saree. It has been over 3 weeks. I want a full refund.']],
    }),
    dispute({
      id: 'PP-D-48219', txn: '3PL88412CD551920M', invoice: 'KL-1051', buyer: 'Aisha R.',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 89, created: -2, due: 2, stage: 'INQUIRY', items: ['Handwoven silk stole – rose pink'],
      messages: [['BUYER', -2, 'The colour is more of a dusty pink than the bright rose in the photos. Not what I expected.']],
    }),
    dispute({
      id: 'PP-D-48224', txn: '9QW55120EF883341N', invoice: 'KL-1058', buyer: 'Mark T.',
      reason: 'UNAUTHORISED', status: 'WAITING_FOR_SELLER_RESPONSE', channel: 'EXTERNAL',
      amount: 512, created: -1, due: 9, items: ['Set of 2 silk sarees – bridal collection', 'Matching silk blouse pieces'],
      messages: [],
    }),
    dispute({
      id: 'PP-D-48230', txn: '5RT90231GH004512P', invoice: 'KL-1063', buyer: 'Olivia K.',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 45, created: -4, due: 1, items: ['Cotton handloom table runner'],
      messages: [['BUYER', -4, 'Tracking has said "in transit" for almost a month. Where is my order?']],
    }),
    dispute({
      id: 'PP-D-48236', txn: '2MN44718JK667103Q', invoice: 'KL-1066', buyer: 'David L.',
      reason: 'DUPLICATE_TRANSACTION', status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 120, created: -1, due: 10, items: ['Silk cushion covers (set of 4)'],
      messages: [['BUYER', -1, 'I was charged twice for the same cushion covers.']],
    }),
    dispute({
      id: 'PP-D-48241', txn: '8BV10295LM228846R', invoice: 'KL-1070', buyer: 'Priya S.',
      reason: 'CREDIT_NOT_PROCESSED', status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: 60, created: -2, due: 5, items: ['Block-printed cotton dupatta'],
      messages: [['BUYER', -2, 'I returned the dupatta two weeks ago and still have not received my refund.']],
    }),
    // Resolved history (drives win-rate / recovered stats)
    dispute({ id: 'PP-D-47702', txn: '1AA00000000000001', invoice: 'KL-0988', buyer: 'Sam P.', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'RESOLVED', amount: 210, created: -40, updated: -25, items: ['Silk saree'], outcome: 'RESOLVED_SELLER_FAVOUR' }),
    dispute({ id: 'PP-D-47815', txn: '1AA00000000000002', invoice: 'KL-1003', buyer: 'Hannah W.', reason: 'UNAUTHORISED', status: 'RESOLVED', amount: 275, created: -32, updated: -18, items: ['Silk saree'], outcome: 'RESOLVED_SELLER_FAVOUR' }),
    dispute({ id: 'PP-D-47901', txn: '1AA00000000000003', invoice: 'KL-1011', buyer: 'Tom B.', reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', status: 'RESOLVED', amount: 95, created: -28, updated: -15, items: ['Stole'], outcome: 'RESOLVED_BUYER_FAVOUR' }),
  ];
}

// Merchant-side context, keyed by PayPal seller_transaction_id.
export const MERCHANT_CONTEXT = {
  '7XK21934AB102233L': {
    order: { order_id: 'KL-1042', placed: iso(-26), items: [{ title: 'Kanchipuram pure silk saree – peacock blue', price: 340, cost: 150, listing_url: 'https://kanchilooms.example/p/peacock-blue-saree' }], ship_to: '41 Maple Ave, Austin, TX 78701, US', bill_to: '41 Maple Ave, Austin, TX 78701, US' },
    shipping: {
      carrier: 'DHL', tracking_number: '1234567890', shipped: iso(-24), delivered: iso(-17), signed_by: 'J. MILLER',
      events: [['Shipment picked up – Chennai, IN', -24], ['Departed hub – Chennai, IN', -23], ['Customs cleared – Cincinnati, US', -20], ['Out for delivery – Austin, TX', -17], ['Delivered – signed by J. MILLER – Austin, TX', -17]],
    },
    customer: { previous_orders: 2, customer_since: iso(-400) },
    comms: [['CUSTOMER', -25, 'Thank you! Can you ship by DHL Express please?'], ['MERCHANT', -24, 'Shipped today via DHL Express, tracking 1234567890.']],
    refunds: [],
  },
  '3PL88412CD551920M': {
    order: { order_id: 'KL-1051', placed: iso(-20), items: [{ title: 'Handwoven silk stole – rose pink', price: 89, cost: 30, listing_url: 'https://kanchilooms.example/p/rose-stole', description: 'Handwoven on traditional looms. Natural dyes – colour may vary slightly from photos.' }], ship_to: '9 Kings Rd, London SW3, UK', bill_to: '9 Kings Rd, London SW3, UK' },
    shipping: { carrier: 'India Post EMS', tracking_number: 'EE123456789IN', shipped: iso(-18), delivered: iso(-8), events: [['Booked – Chennai GPO', -18], ['Delivered – London', -8]] },
    customer: { previous_orders: 0, customer_since: iso(-20) },
    comms: [['CUSTOMER', -7, 'The stole is lovely quality but the pink is softer than I hoped.'], ['MERCHANT', -7, 'Thank you! Natural dyes vary a little – happy to accept a return within 14 days.']],
    refunds: [],
    return_shipping_estimate: 28,
  },
  '9QW55120EF883341N': {
    order: { order_id: 'KL-1058', placed: iso(-15), items: [{ title: 'Set of 2 silk sarees – bridal collection', price: 440, cost: 210 }, { title: 'Matching silk blouse pieces', price: 72, cost: 20 }], ship_to: '220 Lake Shore Dr, Chicago, IL 60611, US', bill_to: '220 Lake Shore Dr, Chicago, IL 60611, US' },
    shipping: { carrier: 'FedEx', tracking_number: '771234567890', shipped: iso(-13), delivered: iso(-8), signed_by: 'M. THOMPSON', events: [['Picked up – Chennai, IN', -13], ['Delivered – signed by M. THOMPSON – Chicago, IL', -8]] },
    customer: { previous_orders: 3, customer_since: iso(-610) },
    risk: { ip_country: 'US', ip_city: 'Chicago', device_seen_before: true, avs_match: true },
    comms: [['CUSTOMER', -14, 'Need these before the wedding on the 20th – thanks!']],
    refunds: [],
  },
  '5RT90231GH004512P': {
    order: { order_id: 'KL-1063', placed: iso(-31), items: [{ title: 'Cotton handloom table runner', price: 45, cost: 12 }], ship_to: '15 Elm St, Portland, OR 97205, US', bill_to: '15 Elm St, Portland, OR 97205, US' },
    shipping: { carrier: 'India Post (registered)', tracking_number: 'RR987654321IN', shipped: iso(-29), delivered: null, events: [['Booked – Chennai GPO', -29], ['Dispatched to destination country', -26], ['In transit', -26]] },
    customer: { previous_orders: 0, customer_since: iso(-31) },
    comms: [],
    refunds: [],
  },
  '2MN44718JK667103Q': {
    order: { order_id: 'KL-1066', placed: iso(-6), items: [{ title: 'Silk cushion covers (set of 4)', price: 120, cost: 40 }], ship_to: '7 Ocean Blvd, Miami, FL 33139, US', bill_to: '7 Ocean Blvd, Miami, FL 33139, US' },
    shipping: { carrier: 'DHL', tracking_number: '5566778899', shipped: iso(-5), delivered: iso(-2), events: [['Delivered – Miami, FL', -2]] },
    customer: { previous_orders: 1, customer_since: iso(-90) },
    comms: [['MERCHANT', -5, 'We noticed you were charged twice by mistake – the duplicate has been refunded.']],
    refunds: [{ refund_id: '4KD23941MM210384X', amount: 120, time: iso(-5), note: 'Duplicate charge refunded' }],
  },
  '8BV10295LM228846R': {
    order: { order_id: 'KL-1070', placed: iso(-30), items: [{ title: 'Block-printed cotton dupatta', price: 60, cost: 14 }], ship_to: '88 Park Ave, Jersey City, NJ 07302, US', bill_to: '88 Park Ave, Jersey City, NJ 07302, US' },
    shipping: { carrier: 'DHL', tracking_number: '9988776655', shipped: iso(-28), delivered: iso(-22), events: [['Delivered – Jersey City, NJ', -22]] },
    return: { tracking_number: 'RTN44556677', received: iso(-9) },
    customer: { previous_orders: 0, customer_since: iso(-30) },
    comms: [['CUSTOMER', -15, 'Returning the dupatta, tracking RTN44556677.']],
    refunds: [],
  },
};
