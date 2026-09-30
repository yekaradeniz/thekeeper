// avgkeeper/scripts/today.mjs
// Reads the account and the market and returns today's split. The plan card, the scheduled buy and the dry run all
// call this one function, so the card shows exactly what a buy would do (ProjectBuilder CLAUDE.md rule 3).
import {
  holdingRows, usdtAvailable, candidates, WHY_PRICE_UNREADABLE,
} from './holdings.mjs';
import { fitMinimums } from './allocate.mjs';
import { toCents } from './decimal.mjs';
import { isRetryable } from './runner.mjs';

const PLAIN_PRICE = /^\d+(\.\d+)?$/;
const isPlainPositive = (v) => typeof v === 'string' && PLAIN_PRICE.test(v) && Number(v) > 0;

export async function readAccount(ctx, call) {
  return holdingRows(await ctx.okx.json(['account', 'balance'], call));
}

// Review finding (today.mjs:17): a reply with no rows, or with rows but none of them a live USDT spot pair, is not
// proof OKX lists none: it used to default to an empty Map the same as that real fact, and every coin then read as
// WHY_NO_PAIR, closing the period as "no coin in the plan is in loss" (rule 2). OKX always lists hundreds of live
// USDT spot pairs, so zero is itself the sign of an unreadable reply, never a fact about the market.
//
// Review finding (today.mjs:26, should): the name kept its own meaning ("live"), but the map itself also holds
// every USDT pair OKX listed that is NOT live (suspend, preopen, or another state), each keyed with its own
// instrument row (state included), so candidates() (holdings.mjs) can tell "no such pair at all" apart from "this
// pair exists but is not trading right now" instead of reading both as the same WHY_NO_PAIR.
export async function liveUsdtPairs(ctx, call) {
  const r = await ctx.okx.json(['market', 'instruments', '--instType', 'SPOT'], call);
  const pairs = new Map();
  let liveCount = 0;
  for (const i of Array.isArray(r.data) ? r.data : []) {
    if (i && i.quoteCcy === 'USDT' && typeof i.instId === 'string') {
      pairs.set(i.instId, i);
      if (i.state === 'live') liveCount += 1;
    }
  }
  if (!Array.isArray(r.data) || !liveCount) {
    throw new Error("OKX's market instruments reply named no live USDT spot pairs.");
  }
  return pairs;
}

// Review finding (today.mjs:26): one ticker's own OKX error (a rejection specific to that instrument, "Instrument
// ID does not exist") used to fail this whole call, closing the entire period as "OKX could not be read" instead
// of leaving just that one coin out with its own reason (spec section 5: "A coin whose price or order size cannot
// be read is left out with that reason before the split"). An auth failure still propagates (the caller halts);
// isRetryable (runner.mjs) still propagates too, so withNetworkRetry (buy.mjs) can retry the whole read the way it
// already does for the other pre-send reads. New regression: isRetryable covers a plain network failure, a rate
// limit and a timeout, but also an ambiguous OKX server code (50001, 50013, a 5xx), the realistic trigger for a
// one-off ticker failure, far more likely than the instrument itself being unreadable; swallowing that as this
// coin's own unreadable price used to drop it and re-split its share onto the others for good, with no retry.
// Anything else about one instId leaves that coin's price null, the same "unreadable" signal a blank or malformed
// last already gives.
export async function lastPrices(ctx, call, instIds) {
  const out = new Map();
  for (const id of instIds) {
    let row;
    try {
      const r = await ctx.okx.json(['market', 'ticker', id], call);
      row = Array.isArray(r.data) ? r.data[0] || {} : {};
    } catch (e) {
      if (e.kind === 'auth' || isRetryable(e)) throw e;
      out.set(id, null);
      continue;
    }
    out.set(id, typeof row.last === 'string' && PLAIN_PRICE.test(row.last) ? row.last : null);
  }
  return out;
}

export async function todaySplit(ctx, call, plan) {
  const budgetCents = toCents(plan.budget);
  if (budgetCents === null) throw new Error('REFUSED: the plan on record cannot be read (its budget). Make a new plan.');
  const rows = await readAccount(ctx, call);
  const pairs = await liveUsdtPairs(ctx, call);
  const { inPlan: candidatesInPlan, out } = candidates(rows, plan, pairs);
  const prices = await lastPrices(ctx, call, candidatesInPlan.map((c) => `${c.ccy}-USDT`));
  const market = new Map(candidatesInPlan.map((c) => [c.ccy, { inst: pairs.get(`${c.ccy}-USDT`), last: prices.get(`${c.ccy}-USDT`) }]));
  // A coin whose price or order size cannot be read never reaches fitMinimums: it is unreadable, not below OKX's
  // minimum. From here on, `dropped` only ever means "below OKX's minimum order size".
  const inPlan = [];
  for (const c of candidatesInPlan) {
    const m = market.get(c.ccy);
    // Review finding (today.mjs:49): m.last already passed PLAIN_PRICE (digits only) in lastPrices, which lets "0"
    // through; isPlainPositive here is what actually rules out a zero or negative price, the same check minSz and
    // lotSz already get.
    const readable = m && m.inst && isPlainPositive(m.last) && isPlainPositive(m.inst.minSz) && isPlainPositive(m.inst.lotSz);
    if (readable) inPlan.push(c);
    else out.push({ ...c, why: WHY_PRICE_UNREADABLE });
  }
  const { shares, dropped } = fitMinimums(inPlan, budgetCents, plan.method, market);
  return { rows, inPlan, out, shares, dropped, market, usdtAvail: usdtAvailable(rows) };
}
