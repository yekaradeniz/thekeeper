// One buy: its client id, its argv, the send, and the read-back. readOrder, fillOf and stillOnTheBook follow
// GridKeeper's removed place.mjs and drip.mjs (git show 107c05f^:gridkeeper/scripts/drip.mjs).
import crypto from 'node:crypto';
import {
  okxCode, reasonOf, ambiguousCode, sCodeMissing, isRetryable,
} from './runner.mjs';
import { centsStr } from './decimal.mjs';

// OKX's "Order does not exist": the only reply that proves an order was never placed (confirmed live 2026-09-11).
const ORDER_NOT_FOUND = '51603';

// ak plus 16 hex of a sha256 over plan, period, pair, profile and mode. The same buy always gets the same id, so a
// run that died between the send and the reply finds out at the next run what happened. OKX allows 1 to 32
// alphanumeric characters starting with a letter.
export function buyClOrdId({ planId, period, instId, profile, demo }) {
  const parts = { planId: String(planId), period: String(period), instId: String(instId), profile: profile || null, demo: Boolean(demo) };
  return 'ak' + crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// A market buy for cash, sized in USDT (--tgtCcy quote_ccy), so the amount sent is the share itself.
export function placeArgs({ instId, cents, clOrdId, code }) {
  return [
    'spot', 'place', '--instId', instId, '--side', 'buy', '--ordType', 'market', '--tdMode', 'cash',
    '--tgtCcy', 'quote_ccy', '--sz', centsStr(cents), '--clOrdId', clOrdId, ...(code ? ['--aiBuilderCode', code] : []),
  ];
}

// { accepted: true }, { rejected: { sCode, sMsg } } or { unknown: reason }. An auth failure is thrown: the caller
// halts the plan. Ambiguous codes, 5xx, timeouts and network failures are unknown, never a rejection. A missing
// row, or a row whose sCode is undefined, null or blank, is also unknown: OKX answered nothing usable, not a
// rejection either (sCodeMissing, runner.mjs: the same reader runner.mjs's own sCodeRejection uses, rule 3).
export async function sendBuy(ctx, call, args) {
  try {
    const r = await ctx.okx.json(args, call);
    const row = Array.isArray(r.data) ? r.data[0] : undefined;
    if (!row || sCodeMissing(row.sCode)) return { unknown: 'OKX sent no order result' };
    if (String(row.sCode) !== '0') {
      return ambiguousCode(row.sCode) ? { unknown: `OKX answered code ${row.sCode}` } : { rejected: { sCode: String(row.sCode), sMsg: String(row.sMsg || '') } };
    }
    return { accepted: true };
  } catch (e) {
    if (e.kind === 'auth') throw e;
    const code = okxCode(e.stderr || e.message);
    if (e.kind === 'cli' && code && !ambiguousCode(code)) return { rejected: { sCode: code, sMsg: reasonOf(e) } };
    return { unknown: reasonOf(e) };
  }
}

// { row }, { notFound: true } or { error, network }. network also covers a rate limit, a timeout and an ambiguous
// OKX code (isRetryable, runner.mjs): each is worth reading again later, none is an answer.
export async function readOrder(ctx, call, { instId, clOrdId }) {
  try {
    const r = await ctx.okx.json(['spot', 'get', '--instId', instId, '--clOrdId', clOrdId], call);
    const row = Array.isArray(r.data) ? r.data[0] : null;
    return row && typeof row === 'object' ? { row } : { error: 'empty reply' };
  } catch (e) {
    if (e.kind === 'auth') throw e;
    if (e.kind === 'cli' && okxCode(e.stderr || e.message) === ORDER_NOT_FOUND) return { notFound: true };
    return { error: reasonOf(e), network: isRetryable(e) };
  }
}

// Names one order the way the user can find it in the OKX app: the pair, its USDT amount, the period it belongs
// to, and the client id AvgKeeper sent it with. One reader for every halt, stop and unknown-order message.
export const orderName = (instId, amount, period, clOrdId) => `${instId} ${amount} USDT on ${period} (client id ${clOrdId})`;

export const stillOnTheBook = (row) => {
  const state = String((row || {}).state || '');
  return state === 'live' || state === 'partially_filled';
};

// OKX's own final states for a spot order (OKX v5 docs, "Order status"): only these prove the order is finished.
// A missing state, or one this build does not recognise, proves nothing either way (rule 2): it is never read as
// "finished with nothing filled".
export const FINAL_ORDER_STATES = new Set(['filled', 'canceled', 'mmp_canceled']);

// What an order reply says about money that moved: filled with a notional, nothing, unreadable, or still pending.
// A row still on the book is read as pending before either size is touched: a live or partially filled order has
// no final notional yet. So is a row whose state is missing or not one of OKX's documented final states: OKX has
// not said the order is finished, so it is never counted as finished with nothing spent on it (review finding,
// buy.mjs:212) or, worse, as a confirmed fill before OKX actually confirmed one. `accFillSz` is OKX v5's
// accumulated filled size (the total so far, base currency for SPOT); `fillSz` is only the size of the LAST fill,
// which undercounts every order with more than one fill. An absent accFillSz is unreadable, never zero: that hole
// once recorded a real buy as free (GridKeeper, 2026-09-15).
// A plain, non-negative decimal string, the same shape today.mjs's own isPlainPositive checks before Number()
// (rule 3, one fact one reader; this one also has to accept 0, unlike that price check). Review finding
// (orders.mjs:86, later): Number() alone reads a whitespace-only string, or a shape like '0x0', as 0, the same as
// a genuine zero fill; neither is proof of anything OKX actually said.
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;
export function fillOf(row) {
  const read = (v) => (typeof v === 'string' && PLAIN_DECIMAL.test(v) ? Number(v) : NaN);
  const r = row || {};
  if (stillOnTheBook(r)) return { kind: 'pending' };
  if (!FINAL_ORDER_STATES.has(String(r.state || ''))) return { kind: 'pending' };
  const sz = read(r.accFillSz);
  const px = read(r.avgPx);
  if (!Number.isFinite(sz) || sz < 0) return { kind: 'unreadable', why: `its filled size reads ${JSON.stringify(r.accFillSz === undefined ? null : r.accFillSz)}` };
  // Review finding (orders.mjs:93, should): a zero filled size is ordinary only for the two states OKX documents
  // as ending with nothing filled (canceled, mmp_canceled). A row that answers 'filled' with accFillSz 0
  // contradicts itself, and picking one field over the other without checking them against each other (rule 2)
  // used to read it as a clean rejection. Unreadable instead, so settleVerdict halts on it.
  if (sz === 0) {
    if (String(r.state) === 'canceled' || String(r.state) === 'mmp_canceled') return { kind: 'none' };
    return { kind: 'unreadable', why: `it reads as ${r.state} with a filled size of 0` };
  }
  if (!(Number.isFinite(px) && px > 0)) return { kind: 'unreadable', why: `it filled ${sz} at an average price that reads ${JSON.stringify(r.avgPx === undefined ? null : r.avgPx)}` };
  return { kind: 'filled', notional: sz * px };
}
