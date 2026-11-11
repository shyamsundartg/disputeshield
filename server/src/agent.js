// The Dispute Defense Agent: gathers context, runs the playbook, then asks
// the LLM to write the case narrative. Emits step events so the UI can
// show the agent working live.
import Anthropic from '@anthropic-ai/sdk';
import { analyzeCase, REASON_LABELS, fmt } from './playbook.js';

const MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export const aiEnabled = () => !!anthropic;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAgent({ dispute, ctx, merchant, onStep = () => {}, pace = 350 }) {
  const step = async (label, detail) => {
    onStep({ label, detail });
    if (pace) await sleep(pace);
  };
  const txn = dispute.disputed_transactions?.[0] || {};
  const amount = `${dispute.dispute_amount?.currency_code} ${dispute.dispute_amount?.value}`;

  await step('Read dispute from PayPal', `${dispute.dispute_id} · ${REASON_LABELS[dispute.reason] || dispute.reason} · ${amount}`);
  await step('Matched PayPal transaction to store order', ctx?.order ? `Txn ${txn.seller_transaction_id} → order ${ctx.order.order_id}` : 'No matching order found in store data');
  if (ctx?.shipping) {
    const last = ctx.shipping.events?.at(-1)?.[0];
    await step(`Checked ${ctx.shipping.carrier} tracking`, `${ctx.shipping.tracking_number} — ${last || 'no scans'}`);
  }
  const msgCount = (ctx?.comms?.length || 0) + (dispute.messages?.length || 0);
  await step('Read customer conversation', `${msgCount} message${msgCount === 1 ? '' : 's'} across email and PayPal`);
  if (ctx?.refunds?.length) await step('Found refund records', ctx.refunds.map((r) => r.refund_id).join(', '));

  const analysis = analyzeCase(dispute, ctx, merchant);
  const have = analysis.checklist.filter((c) => c.have).length;
  await step('Matched evidence to PayPal requirements', `${have}/${analysis.checklist.length} required items found`);
  await step('Scored the case', `Win chance ${Math.round(analysis.winProbability * 100)}% · recommended: ${analysis.decision}`);

  await step(anthropic ? `Drafting response with ${MODEL}` : 'Drafted the response from the evidence', '');
  let draft;
  try {
    draft = anthropic ? await llmDraft(dispute, ctx, merchant, analysis) : templateDraft(dispute, ctx, merchant, analysis);
  } catch (e) {
    onStep({ label: 'AI drafting failed, used template', detail: e.message });
    draft = templateDraft(dispute, ctx, merchant, analysis);
  }

  // Put the narrative into the evidence payload PayPal will receive.
  const evidences = analysis.evidences.map((e, i) => ({ ...e, notes: i === 0 ? draft.response_notes.slice(0, 2000) : e.notes }));
  await step('Case ready for your review', draft.summary);

  return { ...analysis, evidences, draft, model: anthropic ? MODEL : 'template', analyzedAt: new Date().toISOString() };
}

// Claude returns the draft through a forced tool call, so the reply is always
// structured JSON the app can read (no parsing free text).
const DRAFT_TOOL = {
  name: 'submit_draft',
  description: 'Return the drafted dispute response for the merchant to review.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence for the merchant.' },
      reasoning: { type: 'string', description: '2-4 sentences explaining the recommendation and the money trade-off.' },
      response_notes: { type: 'string', description: "Statement for PayPal's dispute reviewer: factual, chronological, cites evidence, max 1500 characters." },
      buyer_message: { type: 'string', description: 'Short, warm message the merchant could send the buyer, or an empty string.' },
      risks: { type: 'array', items: { type: 'string' }, description: 'Weaknesses in the case or missing evidence.' },
    },
    required: ['summary', 'reasoning', 'response_notes', 'buyer_message', 'risks'],
  },
};

async function llmDraft(dispute, ctx, merchant, analysis) {
  const facts = buildFacts(dispute, ctx, merchant, analysis);
  const system = `You are a dispute specialist helping a small merchant respond to PayPal disputes.
Rules:
- Use ONLY the facts provided. Never invent tracking events, dates, messages, or documents.
- If the facts show the buyer is right, say so plainly and recommend refunding. Honesty protects the merchant's account.
- response_notes is read by a PayPal dispute reviewer: factual, chronological, cites evidence, max 1500 characters, no emotion, no blame.
- buyer_message is a short, warm message the merchant could send the buyer (or empty string if not useful).
Return your draft by calling the submit_draft tool.`;

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system,
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'tool', name: DRAFT_TOOL.name },
    messages: [{ role: 'user', content: `Case facts (JSON):\n${JSON.stringify(facts, null, 2)}` }],
  });
  const call = msg.content.find((b) => b.type === 'tool_use' && b.name === DRAFT_TOOL.name);
  if (!call) throw new Error(`Claude returned no draft (stop reason: ${msg.stop_reason})`);
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude ran out of space writing the draft');
  const json = call.input || {};
  return {
    summary: String(json.summary || ''),
    reasoning: String(json.reasoning || ''),
    response_notes: String(json.response_notes || '').slice(0, 2000),
    buyer_message: String(json.buyer_message || ''),
    risks: Array.isArray(json.risks) ? json.risks.map(String) : [],
  };
}

function buildFacts(dispute, ctx, merchant, a) {
  return {
    merchant: { name: merchant.name, location: merchant.location, return_policy: merchant.return_policy },
    dispute: {
      id: dispute.dispute_id,
      reason: dispute.reason,
      amount: dispute.dispute_amount,
      stage: dispute.dispute_life_cycle_stage,
      opened: dispute.create_time,
      buyer_messages: (dispute.messages || []).map((m) => ({ by: m.posted_by, at: m.time_posted, text: m.content })),
    },
    order: ctx?.order,
    shipping: ctx?.shipping && { ...ctx.shipping, events: (ctx.shipping.events || []).map(([e]) => e) },
    return: ctx?.return,
    refunds: ctx?.refunds,
    customer_history: ctx?.customer,
    risk_signals: ctx?.risk,
    conversation: (ctx?.comms || []).map(([who, , text]) => ({ who, text })),
    playbook: {
      evidence_checklist: a.checklist,
      signals: a.signals,
      win_probability: a.winProbability,
      recommended_decision: a.decision,
      economics: a.economics,
      offer: a.offer,
      honesty_flag: a.honestyFlag,
    },
  };
}

function templateDraft(dispute, ctx, merchant, a) {
  const o = ctx?.order;
  const s = ctx?.shipping;
  const pct = Math.round(a.winProbability * 100);
  const lines = [];
  if (o) lines.push(`Order ${o.order_id} placed ${fmt(o.placed)} for: ${o.items.map((i) => i.title).join('; ')}. Shipped to ${o.ship_to} (matches PayPal billing address: ${o.ship_to === o.bill_to ? 'yes' : 'no'}).`);
  if (s) lines.push(`Shipped ${fmt(s.shipped)} via ${s.carrier}, tracking ${s.tracking_number}.${s.delivered ? ` Carrier confirms delivery on ${fmt(s.delivered)}${s.signed_by ? `, signed by ${s.signed_by}` : ''}.` : ''}`);
  if (ctx?.refunds?.length) lines.push(`Refund already issued: ${ctx.refunds.map((r) => `${r.refund_id} (USD ${r.amount}, ${fmt(r.time)})`).join(', ')}.`);
  if (ctx?.customer?.previous_orders) lines.push(`Buyer has ${ctx.customer.previous_orders} previous completed orders with us and no prior disputes.`);
  if (dispute.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') lines.push(`Listing states: "${o?.items?.[0]?.description || ''}". Our policy: ${merchant.return_policy}`);
  lines.push('Supporting evidence pack attached.');

  const summaries = {
    FIGHT: `Strong case (${pct}% win chance) — submit evidence and fight.`,
    OFFER: `Mixed case — a ${a.offer ? Math.round(a.offer.pct * 100) : 25}% partial refund is cheaper than fighting or a return.`,
    ACCEPT: a.honestyFlag ? 'The buyer is right — refund and close this out.' : `Weak case (${pct}% win chance) — refunding costs less than fighting.`,
  };
  return {
    summary: summaries[a.decision],
    reasoning: a.honestyFlag || [
      a.signals.filter((s) => s.ok).map((s) => s.label.toLowerCase()).join(', ').replace(/^./, (c) => c.toUpperCase()) + '.',
      `Fighting has an expected cost of $${a.economics.expectedLossFight.toFixed(2)}${a.offer ? `, a partial refund costs $${a.offer.amount.toFixed(2)}` : ''}, and refunding costs $${a.economics.refundLoss.toFixed(2)}.`,
    ].join(' '),
    response_notes: lines.join('\n'),
    buyer_message: a.decision === 'OFFER' ? `Hi ${dispute.disputed_transactions?.[0]?.buyer?.name?.split(' ')[0] || 'there'}, we're sorry the colour wasn't what you hoped. Natural dyes vary a little — we'd like to refund ${a.offer.amount} USD and you keep the stole.` : '',
    risks: a.checklist.filter((c) => !c.have).map((c) => `Missing: ${c.item}`),
  };
}
