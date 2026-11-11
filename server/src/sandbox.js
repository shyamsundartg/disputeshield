// Sandbox test-data helper: creates a real PayPal sandbox payment for a
// Kanchi Looms product, and records matching store data (order, courier
// tracking, messages) so the agent has evidence to work with once the
// buyer opens a dispute on that payment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_FILE = path.join(__dirname, '..', 'data', 'merchant-context.json');
const DAY = 86_400_000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString();

// Each scenario is a story the dispute can be tested against.
export const SCENARIOS = {
  delivered: {
    label: 'Delivered with signature (agent should say fight)',
    product: { title: 'Kanchipuram pure silk saree – peacock blue', price: 34, cost: 15, description: 'Handwoven pure silk with zari border.' },
    carrier: 'DHL',
    shipping: (name) => ({
      tracking_number: String(1000000000 + Math.floor(Math.random() * 8999999999)).slice(0, 10),
      shipped: iso(0), delivered: iso(0), signed_by: name.toUpperCase(),
      events: [['Shipment picked up – Chennai, IN', 0], ['Customs cleared', 0], ['Delivered – signed by ' + name.toUpperCase(), 0]],
    }),
    previous_orders: 2,
    comms: [['CUSTOMER', 0, 'Thank you! Please ship by DHL Express.'], ['MERCHANT', 0, 'Shipped today via DHL Express.']],
  },
  in_transit: {
    label: 'Stuck in transit (agent should say refund)',
    product: { title: 'Cotton handloom table runner', price: 12, cost: 4, description: 'Handloom cotton.' },
    carrier: 'India Post (registered)',
    shipping: () => ({
      tracking_number: `RR${Math.floor(100000000 + Math.random() * 899999999)}IN`,
      shipped: iso(-29), delivered: null,
      events: [['Booked – Chennai GPO', -29], ['Dispatched to destination country', -26], ['In transit', -26]],
    }),
    previous_orders: 0,
    comms: [],
  },
  not_as_described: {
    label: 'Colour complaint (agent should suggest partial refund)',
    product: { title: 'Handwoven silk stole – rose pink', price: 18, cost: 6, description: 'Handwoven on traditional looms. Natural dyes – colour may vary slightly from photos.' },
    carrier: 'India Post EMS',
    shipping: () => ({
      tracking_number: `EE${Math.floor(100000000 + Math.random() * 899999999)}IN`,
      shipped: iso(-12), delivered: iso(-3),
      events: [['Booked – Chennai GPO', -12], ['Delivered', -3]],
    }),
    previous_orders: 0,
    comms: [['CUSTOMER', -2, 'The stole is lovely quality but the pink is softer than I hoped.'], ['MERCHANT', -2, 'Natural dyes vary a little – happy to accept a return within 14 days.']],
    return_shipping_estimate: 28,
  },
};

export async function createOrder(paypal, { scenario = 'delivered', baseUrl }) {
  const s = SCENARIOS[scenario] || SCENARIOS.delivered;
  const invoice = `KL-${Date.now().toString().slice(-6)}`;
  const value = s.product.price.toFixed(2);
  const order = await paypal.req('POST', '/v2/checkout/orders', {
    json: {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: scenario,
        invoice_id: invoice,
        description: s.product.title,
        custom_id: scenario,
        amount: { currency_code: 'USD', value, breakdown: { item_total: { currency_code: 'USD', value } } },
        items: [{ name: s.product.title.slice(0, 120), quantity: '1', category: 'PHYSICAL_GOODS', unit_amount: { currency_code: 'USD', value } }],
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Kanchi Looms',
            shipping_preference: 'GET_FROM_FILE',
            user_action: 'PAY_NOW',
            return_url: `${baseUrl}/api/sandbox/return`,
            cancel_url: `${baseUrl}/?sandbox=cancelled`,
          },
        },
      },
    },
  });
  const approve = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!approve) throw new Error('PayPal did not return a checkout link for the test order.');
  return { orderId: order.id, approveUrl: approve.href, invoice };
}

export async function captureOrder(paypal, store, orderId) {
  const cap = await paypal.req('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { json: {} });
  const pu = cap.purchase_units?.[0] || {};
  const capture = pu.payments?.captures?.[0];
  if (!capture) throw new Error('PayPal did not return a capture for this order.');
  const scenario = SCENARIOS[pu.reference_id] ? pu.reference_id : 'delivered';
  const s = SCENARIOS[scenario];
  const name = [cap.payer?.name?.given_name, cap.payer?.name?.surname].filter(Boolean).join(' ') || 'Sandbox Buyer';
  const a = pu.shipping?.address || {};
  const address = [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].filter(Boolean).join(', ') || 'Sandbox address';

  const entry = {
    scenario,
    order: {
      order_id: pu.invoice_id || capture.invoice_id || orderId,
      paypal_order_id: orderId,
      placed: iso(0),
      items: [{ ...s.product, listing_url: 'https://kanchilooms.example/p/' + scenario }],
      ship_to: address,
      bill_to: address,
    },
    shipping: { carrier: s.carrier, ...s.shipping(name) },
    customer: { previous_orders: s.previous_orders, customer_since: iso(-200) },
    comms: s.comms,
    refunds: [],
  };
  if (s.return_shipping_estimate) entry.return_shipping_estimate = s.return_shipping_estimate;
  if (scenario === 'delivered') entry.risk = { ip_country: a.country_code || 'US', device_seen_before: true, avs_match: true };

  store.context[capture.id] = entry;
  const all = readContext();
  all[capture.id] = entry;
  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(all, null, 2));
  store.log(null, 'TEST_PAYMENT', `Captured ${capture.id} (${s.label}) for USD ${capture.amount?.value}`);
  return { transactionId: capture.id, scenario, amount: capture.amount?.value, buyer: name };
}

export function listTestPayments(store) {
  return Object.entries(store.context)
    .filter(([, c]) => c.order?.paypal_order_id)
    .map(([id, c]) => ({ transactionId: id, scenario: c.scenario, label: SCENARIOS[c.scenario]?.label, item: c.order.items[0]?.title, amount: c.order.items[0]?.price, placed: c.order.placed }))
    .sort((a, b) => new Date(b.placed) - new Date(a.placed));
}

function readContext() {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
  } catch {
    return {};
  }
}
