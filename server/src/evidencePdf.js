// Builds the evidence-pack PDF that is attached to the PayPal provide-evidence call.
import PDFDocument from 'pdfkit';
import { REASON_LABELS, fmt } from './playbook.js';

export function buildEvidencePdf({ dispute, ctx, merchant, result }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const h = (t) => doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor('#111').text(t).moveDown(0.3).font('Helvetica').fontSize(10).fillColor('#222');
    const kv = (k, v) => v && doc.font('Helvetica-Bold').text(`${k}: `, { continued: true }).font('Helvetica').text(String(v));

    doc.font('Helvetica-Bold').fontSize(18).text(`Dispute evidence — ${dispute.dispute_id}`);
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(`${merchant.name}, ${merchant.location} · prepared ${fmt(new Date())}`);
    doc.fillColor('#222');

    h('Dispute');
    kv('Reason', REASON_LABELS[dispute.reason] || dispute.reason);
    kv('Amount', `${dispute.dispute_amount.currency_code} ${dispute.dispute_amount.value}`);
    kv('PayPal transaction', dispute.disputed_transactions?.[0]?.seller_transaction_id);

    h('Statement');
    doc.text(result.draft.response_notes);

    if (ctx?.order) {
      h('Order');
      kv('Order ID', ctx.order.order_id);
      kv('Placed', fmt(ctx.order.placed));
      ctx.order.items.forEach((i) => doc.text(`• ${i.title} — USD ${i.price}${i.listing_url ? ` (${i.listing_url})` : ''}`));
      if (ctx.order.items[0]?.description) kv('Listing description', ctx.order.items[0].description);
      kv('Ship to', ctx.order.ship_to);
      kv('Bill to', ctx.order.bill_to);
    }

    if (ctx?.shipping) {
      h(`Shipment — ${ctx.shipping.carrier} ${ctx.shipping.tracking_number}`);
      (ctx.shipping.events || []).forEach(([e, d]) => doc.text(`${fmt(Date.now() + d * 86_400_000)}  ${e}`));
    }
    if (ctx?.refunds?.length) {
      h('Refunds issued');
      ctx.refunds.forEach((r) => doc.text(`${r.refund_id} — USD ${r.amount} on ${fmt(r.time)}${r.note ? ` (${r.note})` : ''}`));
    }
    if (ctx?.customer) {
      h('Customer history');
      doc.text(`${ctx.customer.previous_orders} previous orders · customer since ${fmt(ctx.customer.customer_since)}`);
    }
    if (ctx?.comms?.length) {
      h('Correspondence');
      ctx.comms.forEach(([who, d, t]) => doc.text(`${fmt(Date.now() + d * 86_400_000)} ${who}: ${t}`));
    }
    h('Return policy');
    doc.text(merchant.return_policy);
    doc.end();
  });
}
