// avgkeeper/scripts/holdings.mjs
// Which coins the plan buys today. Profit and loss is OKX's own spotUplRatio against openAvgPx, the figure the
// OKX Global app shows (verified on the owner's account, 2026-09-26). Every figure goes through num(): a field OKX
// did not send is NaN and keeps the coin out, never counts as zero.
import { num } from './units.mjs';
import { toCents } from './decimal.mjs';

// Dollar stablecoins never join a plan: "lowering the average" of a coin pinned to one dollar means nothing, and
// at 0.999 one would read as a small loss and take an equal share. Gold-pegged coins such as XAUT do join.
export const USD_PEGGED = new Set([
  'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'PYUSD', 'USDG', 'USDE', 'RLUSD', 'USDD', 'USDS', 'BUSD', 'GUSD', 'FRAX', 'LUSD', 'USD1',
]);
export const DUST_DEFAULT = '10';

// The --dust flag as whole cents, defaulted and checked the one way holdings and plan both read it: { cents } or
// { error } for the same REFUSED sentence either verb prints.
export function readDust(dust) {
  const cents = toCents(dust === undefined ? DUST_DEFAULT : String(dust));
  if (cents === null) return { error: `--dust must be a USDT amount with at most two decimals; it reads ${dust}.` };
  return { cents };
}

// Throws when the same ccy shows up in two detail rows: OKX's account balance is supposed to hold one row per
// currency, and a duplicate means AvgKeeper cannot tell which row is the true holding, so it refuses rather than
// silently picking (or worse, adding) one.
//
// Review finding (today.mjs:17): a reply with no `data` array at all, or one whose elements never carry a
// `details` array, is not proof the account holds nothing: it is a shape this build cannot read at all, and used
// to default to `[]` the same as a genuinely empty account, so a period would skip as "no coin in the plan is in
// loss" (rule 1, never invent a number OKX did not send; rule 2, never state a cause the code did not check). An
// element that DOES carry a `details` array, even an empty one (a real account holding nothing), still reads as
// zero rows: only the shape itself, never the emptiness, throws.
export function holdingRows(reply) {
  const data = reply && reply.data;
  if (!Array.isArray(data) || !data.some((a) => a && Array.isArray(a.details))) {
    throw new Error("OKX's account balance reply could not be read (no readable details array).");
  }
  const details = data.flatMap((a) => (a && Array.isArray(a.details) ? a.details : []));
  const seen = new Set();
  const rows = [];
  for (const d of details) {
    if (!d || typeof d.ccy !== 'string' || !d.ccy) continue;
    if (seen.has(d.ccy)) {
      throw new Error(`REFUSED: OKX listed ${d.ccy} twice in the account balance, so AvgKeeper cannot tell what you hold. Nothing was sent.`);
    }
    seen.add(d.ccy);
    rows.push({
      ccy: d.ccy,
      eqUsd: num(d.eqUsd),
      avgPx: num(d.openAvgPx),
      avgPxRaw: d.openAvgPx,
      // Review finding (manage.mjs:82): the amount actually held, OKX's own eq (never defaulted: a field OKX did
      // not send is NaN, rule 1). eqRaw keeps the original string so a display reader can show it at full
      // precision (sigPrice), the same way avgPxRaw does for openAvgPx.
      amount: num(d.eq),
      amountRaw: d.eq,
      uplRatio: num(d.spotUplRatio),
      availBal: num(d.availBal),
    });
  }
  return rows;
}

export function usdtAvailable(rows) {
  const r = rows.find((x) => x.ccy === 'USDT');
  return r ? r.availBal : NaN;
}

// Every reason a coin can land in `out`, named once so today.mjs's own exclusion (unreadable price or order size)
// and buy.mjs's severity check read the same words candidates() writes (rule 3, one fact one reader).
export const WHY_STABLECOIN = 'a dollar stablecoin';
export const WHY_NOT_ONLY = 'not on your only-these list';
export const WHY_EXCLUDED = 'on your exclude list';
export const WHY_NO_PAIR = 'no USDT spot pair on OKX';
// Review finding (today.mjs:26, should): a pair OKX lists but does not mark 'live' (suspend, preopen, or no state
// at all) is not the same fact as no pair existing at all; WHY_NO_PAIR used to cover both, which read a coin in
// loss as having no market and skipped the whole period as "no coin in the plan is in loss" (rule 2, a cause the
// code never checked). Named with the state OKX actually answered, never invented (rule 1).
export const pairNotLiveWhy = (state) => `its USDT pair is not trading on OKX right now (state ${state === undefined ? 'unknown' : state})`;
const PAIR_NOT_LIVE_RE = /^its USDT pair is not trading on OKX right now/;
export const isPairNotLiveWhy = (why) => PAIR_NOT_LIVE_RE.test(String(why || ''));
export const WHY_VALUE_UNREADABLE = 'its value could not be read';
export const WHY_LOSS_UNREADABLE = 'OKX sent no profit or loss figure for it';
export const WHY_IN_PROFIT = 'in profit';
export const WHY_PRICE_UNREADABLE = 'its price or order size could not be read from OKX';
// Review finding (holdings.mjs:106): an only-these coin the account does not hold at all (a typo, or one sold
// off) never reached this loop's own rows, so it was invisible everywhere: not out, not in, just gone. It is now
// named the same way any other left-out coin is.
export const WHY_NOT_HELD = 'not in this account';
// Review finding (cards.mjs:84, should): an only-these list naming USDT used to read it as WHY_NOT_HELD-eligible
// but skipped it before that check ever ran, so it landed nowhere at all: not in, not out, invisible. USDT is
// still never a buy candidate (it is the budget currency itself), named now the same way every other left-out
// only-these coin is.
export const WHY_BUDGET_CURRENCY = 'the budget currency itself, never something to buy';
const dustWhy = (dust) => `worth under ${dust.toFixed(2)} USDT`;

// The reasons that depend on a figure OKX did not send readably for this read, as opposed to a known answer (in
// profit, dust) or the plan's own configuration (stablecoin, lists, no pair).
export const UNREADABLE_WHY = new Set([WHY_VALUE_UNREADABLE, WHY_LOSS_UNREADABLE, WHY_PRICE_UNREADABLE]);
export const isUnreadableWhy = (why) => UNREADABLE_WHY.has(why);

// The out-list coins left out only because OKX sent no readable figure for them (any of spotUplRatio, eqUsd, price,
// minSz or lotSz).
export const unreadableCoins = (out) => out.filter((c) => isUnreadableWhy(c.why));

// The one sentence naming every coin left out for an unreadable figure, one clause per reason, or '' when there is
// none. buy.mjs reads it for both the skip line and the buy summary (rule 3, one fact one reader). Each clause says
// only what its reason proves (rule 2): candidates() lets a coin through to the price read only once its loss ratio
// read below zero, so a coin dropped for an unreadable price is known to be in loss; a coin with no readable loss
// or value figure is not. Findings 1 and 2 of the 2026-09-27 release-readiness review: a known answer about some
// other coin (in profit, dust) is no evidence about these, so they are named whatever the other coins are.
export function unreadableLine(out) {
  const coins = unreadableCoins(out);
  const named = (why) => coins.filter((c) => c.why === why).map((c) => c.ccy);
  const pick = (list, one, many) => (list.length === 1 ? one : many);
  const loss = named(WHY_LOSS_UNREADABLE);
  const value = named(WHY_VALUE_UNREADABLE);
  const price = named(WHY_PRICE_UNREADABLE);
  return [
    loss.length ? `OKX sent no profit or loss figure for ${loss.join(', ')}, so AvgKeeper cannot tell whether ${pick(loss, 'it is', 'they are')} in loss; not bought.` : '',
    value.length ? `OKX sent no readable value for ${value.join(', ')}, so AvgKeeper cannot tell whether ${pick(value, 'it is', 'they are')} worth at least the plan's dust threshold; not bought.` : '',
    price.length ? `${price.join(', ')} ${pick(price, 'is', 'are')} in loss, but ${pick(price, 'its', 'their')} price or order size could not be read from OKX; not bought.` : '',
  ].filter(Boolean).join(' ');
}

// The only-these coins the account does not hold at all, and the one sentence naming them, or '' when there are
// none. Read the same way unreadableLine is (rule 3): buy.mjs uses it for both the skip line and the buy summary,
// at problem severity, since a config mismatch is as much a reason to alert the user as an unreadable figure is.
export const notHeldCoins = (out) => out.filter((c) => c.why === WHY_NOT_HELD);
export function notHeldLine(out) {
  const coins = notHeldCoins(out);
  if (!coins.length) return '';
  const names = coins.map((c) => c.ccy).join(', ');
  const many = coins.length > 1;
  return `${names} ${many ? 'are' : 'is'} on your only-these list, but this account does not hold ${many ? 'them' : 'it'}; not bought.`;
}

// The out-list coins left out only because their pair is listed but not live, and the sentence naming them, read
// the same way notHeldLine and unreadableLine are (rule 3): a config mismatch or a market state, not a genuine
// no-loss day, so buy.mjs and cards.mjs both raise it to problem severity.
export const pairNotLiveCoins = (out) => out.filter((c) => isPairNotLiveWhy(c.why));
export function pairNotLiveLine(out) {
  const coins = pairNotLiveCoins(out);
  if (!coins.length) return '';
  return coins.map((c) => `${c.ccy} is in loss, but ${c.why}; not bought.`).join(' ');
}

// Review finding (cards.mjs:84, should): a coin left out for a configuration reason (a dollar stablecoin, no USDT
// spot pair, or the budget currency itself) never reaches the loss check at all (reasonOut returns before it), so
// "no coin in the plan is in loss" is false for it, the same class as an unreadable figure or a not-held coin.
// Read the same way those are (rule 3), grouped by reason so a repeated cause names every coin once.
export const CONFIG_WHYS = new Set([WHY_STABLECOIN, WHY_NO_PAIR, WHY_BUDGET_CURRENCY]);
export const isConfigWhy = (why) => CONFIG_WHYS.has(why);
export const configExcludedCoins = (out) => out.filter((c) => isConfigWhy(c.why));
export function configExcludedLine(out) {
  const coins = configExcludedCoins(out);
  if (!coins.length) return '';
  const named = (why) => coins.filter((c) => c.why === why).map((c) => c.ccy);
  const pick = (list, one, many) => (list.length === 1 ? one : many);
  const stable = named(WHY_STABLECOIN);
  const noPair = named(WHY_NO_PAIR);
  const budget = named(WHY_BUDGET_CURRENCY);
  return [
    stable.length ? `${stable.join(', ')} ${pick(stable, 'is', 'are')} a dollar stablecoin, which never counts; not bought.` : '',
    noPair.length ? `${noPair.join(', ')} ${pick(noPair, 'has', 'have')} no USDT spot pair on OKX; not bought.` : '',
    budget.length ? `${budget.join(', ')} ${pick(budget, 'is', 'are')} ${budget.length === 1 ? WHY_BUDGET_CURRENCY : 'the budget currency itself, never something to buy'}; not bought.` : '',
  ].filter(Boolean).join(' ');
}

// Review finding (holdings.mjs:178, blocker): the not-live check used to run right after the pair-exists check,
// before dust or loss were ever read. So an in-profit coin, or a dust leftover, whose pair happened to be
// suspended was reported "in loss, but its pair is not trading" although its loss was never checked (rule 2, a
// cause the code did not check). It now runs last, once a coin has already passed dust and loss and would
// otherwise be bought: only then does a suspended or unlisted-live pair matter.
function reasonOut(r, only, exclude, dust, pairs) {
  if (USD_PEGGED.has(r.ccy)) return WHY_STABLECOIN;
  if (only && !only.has(r.ccy)) return WHY_NOT_ONLY;
  if (exclude.has(r.ccy)) return WHY_EXCLUDED;
  const pair = pairs.get(`${r.ccy}-USDT`);
  if (!pair) return WHY_NO_PAIR;
  if (!only && !(r.eqUsd >= dust)) return Number.isFinite(r.eqUsd) ? dustWhy(dust) : WHY_VALUE_UNREADABLE;
  if (!Number.isFinite(r.uplRatio)) return WHY_LOSS_UNREADABLE;
  if (!(r.uplRatio < 0)) return WHY_IN_PROFIT;
  // pair.state is undefined for a caller (or an older test fixture) that never carried a state at all: treated as
  // usable, since no information about liveness was ever given, never as "not live" on an absent field (rule 1).
  if (pair.state !== undefined && pair.state !== 'live') return pairNotLiveWhy(pair.state);
  return null;
}

// plan: { only: string[] | null, exclude: string[] | null, dust: '10.00' }. pairs: Map of live USDT spot instIds.
export function candidates(rows, plan, pairs) {
  const only = plan.only ? new Set(plan.only) : null;
  const exclude = new Set(plan.exclude || []);
  const dust = Number(plan.dust);
  const inPlan = [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    // Review finding (holdings.mjs:152): USDT was skipped before this loop ever marked it "seen", so an
    // only-these list naming USDT (readPlanFlags accepts it) read USDT as a coin the account does not hold at
    // all, even when the account plainly holds it. USDT is still never a buy candidate (it is the budget
    // currency, not something to buy), but the account holding it is a fact the not-held check below still needs.
    if (r.ccy === 'USDT') {
      seen.add(r.ccy);
      // Review finding (cards.mjs:84, should): named as out, with its own reason, only when the user actually put
      // it on the only-these list; an ordinary plan (no --only) never lists USDT at all, unchanged.
      if (only && only.has('USDT')) out.push({ ...r, why: WHY_BUDGET_CURRENCY });
      continue;
    }
    seen.add(r.ccy);
    const why = reasonOut(r, only, exclude, dust, pairs);
    if (why) out.push({ ...r, why });
    else inPlan.push({ ...r, lossPct: -r.uplRatio * 100 });
  }
  // Review finding (holdings.mjs:106): an only-these coin this account never had a row for at all (a typo, or a
  // coin sold off entirely) is never visited by the loop above, so it stayed invisible everywhere instead of
  // landing in `out` the way every other left-out coin does.
  if (only) {
    for (const ccy of only) {
      if (!seen.has(ccy)) out.push({ ccy, why: WHY_NOT_HELD });
    }
  }
  return { inPlan, out };
}
