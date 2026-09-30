// avgkeeper/scripts/allocate.mjs
// Splits one period's budget. Whole cents only; the shares always add up to the budget exactly.
import { dec, cmpDec, sizeFromQuote, centsStr } from './decimal.mjs';

// Coins in order of loss, largest first, then by symbol, so a tie always resolves the same way.
const byLoss = (a, b) => b.lossPct - a.lossPct || (a.ccy < b.ccy ? -1 : a.ccy > b.ccy ? 1 : 0);

export function split(coins, budgetCents, method) {
  const order = [...coins].sort(byLoss);
  const n = order.length;
  if (!n) return [];
  const weights = order.map((c) => (method === 'weighted' ? c.lossPct : 1));
  const total = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map((w) => (budgetCents * w) / total);
  const cents = raw.map((r) => Math.floor(r));
  let left = budgetCents - cents.reduce((s, c) => s + c, 0);
  const byFraction = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k += 1, left -= 1) cents[byFraction[k % n][1]] += 1;
  return order.map((c, i) => ({ ccy: c.ccy, lossPct: c.lossPct, cents: cents[i] }));
}

// Whether `cents` of USDT buys at least the pair's minSz at the last price, after flooring to its lot size.
// m: { inst, last } with last a plain decimal string, or null when the price could not be read.
export function meetsMinimum(cents, m) {
  if (!m || !m.inst || !m.last) return false;
  const size = sizeFromQuote(centsStr(cents), String(m.last), m.inst);
  const min = dec(String(m.inst.minSz));
  return Boolean(size && min && cmpDec(dec(size), min) >= 0);
}

// market: Map ccy -> { inst, last }. Drops the smallest failing share, re-splits, and repeats.
export function fitMinimums(coins, budgetCents, method, market) {
  let pool = [...coins];
  const dropped = [];
  while (pool.length) {
    const shares = split(pool, budgetCents, method);
    const failing = shares
      .filter((s) => !meetsMinimum(s.cents, market.get(s.ccy)))
      .sort((a, b) => a.cents - b.cents || a.lossPct - b.lossPct || (a.ccy < b.ccy ? 1 : -1));
    if (!failing.length) return { shares, dropped };
    dropped.push({ ccy: failing[0].ccy, cents: failing[0].cents });
    pool = pool.filter((c) => c.ccy !== failing[0].ccy);
  }
  return { shares: [], dropped };
}
