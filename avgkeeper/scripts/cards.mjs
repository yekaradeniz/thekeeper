// avgkeeper/scripts/cards.mjs
// Every sentence the plan card, the receipt and status print. One place, so a fact reads the same on every screen.
import { parseCadence, isBuyDay } from './period.mjs';
import { centsStr, toCents } from './decimal.mjs';
import { usd } from './units.mjs';
import { mailLine } from './mail.mjs';
import { builderDisclosure, keyInactivityWarning } from './guards.mjs';
import {
  unreadableCoins, notHeldCoins, unreadableLine, notHeldLine, pairNotLiveCoins, pairNotLiveLine,
  configExcludedCoins, configExcludedLine,
} from './holdings.mjs';

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function cadenceWords(cadence) {
  const c = parseCadence(cadence);
  if (!c) return `on a schedule AvgKeeper cannot read (${cadence})`;
  if (c.kind === 'hour') return 'every hour';
  if (c.kind === 'day') return 'every day';
  if (c.kind === 'days') return `every ${c.n} days`;
  if (c.kind === 'week') return `every ${WEEKDAY_NAMES[c.weekday - 1]}`;
  // Review finding (cards.mjs:21, should): isBuyDay buys on min(day, daysInMonth), so a day of 1 to 28 always
  // exists in every month (even February); the clause is true only for a day beyond February's own 28.
  return `on day ${c.day} of every month${c.day > 28 ? ' (the last day in a shorter month)' : ''}`;
}

export const methodWords = (m) => (m === 'weighted' ? 'split by loss size' : 'split equally');
export const planLine = (p) => `${p.budget} USDT ${cadenceWords(p.cadence)} at ${p.at} (${p.timeZone}), ${methodWords(p.method)}.`;

export function coinsLine(p) {
  const who = p.only ? `Only ${p.only.join(', ')}, when in loss.` : p.exclude ? `Every coin in loss except ${p.exclude.join(', ')}.` : 'Every coin in loss.';
  const dust = p.only ? '' : ` Coins worth under ${p.dust} USDT are left out.`;
  return `${who}${dust} Dollar stablecoins never count.`;
}

// 720 = 30 x 24: an hourly plan's own monthly estimate (section 10).
const PER_MONTH = {
  hour: () => 720, day: () => 30, days: (c) => 30 / c.n, week: () => 52 / 12, month: () => 1,
};
export function monthlyUsdt(p) {
  const c = parseCadence(p.cadence);
  return c ? Number(p.budget) * PER_MONTH[c.kind](c) : NaN;
}

// The one sentence naming coins dropped for OKX's minimum order size (allocate.mjs's fitMinimums): the coin's
// share was below OKX's minimum order size at that buy, and it went to the others. This is designed behaviour, not
// a problem: it never states any other cause. Every surface that shows a drop uses this one builder (ProjectBuilder
// CLAUDE.md rule 4), so a coin dropped this way never disappears after the plan card: splitLines below (the plan
// card and buy --dry-run), the buy run's own summary (buy.mjs, which reaches notify and the mail notice at level
// all), and status's Recent section (manage.mjs). null when there is nothing to say.
// sharesRemain: whether any coin still got a share this buy (t.shares.length, or the ledger's own buy_filled/
// buy_sent lines for a past period). Review finding (cards.mjs:48): "Their share went to the others" is false when
// every coin in loss was itself dropped for OKX's minimum, since nothing was bought and there is no "others" left.
// Defaults true: buy.mjs's own summary and status's Recent line only ever call this once shares is already known
// non-empty (buyPeriod returns before either is reached otherwise), so neither has to pass it.
export function droppedLine(dropped, sharesRemain = true) {
  if (!dropped || !dropped.length) return null;
  const tail = sharesRemain ? ' Their share went to the others.' : '';
  return `Too small for OKX's minimum order: ${dropped.map((d) => d.ccy).join(', ')}.${tail}`;
}

// Review finding (buy.mjs:442): the gate a real buy checks before it ever sends anything because free USDT is
// below the plan's own budget, read the same way here, in buyPeriod (buy.mjs) and in the dry run (rule 3, one
// fact one reader), so a number the card, a dry run and a real skip show can never drift apart. t: todaySplit's
// own return (only usdtAvail is read); null when no split has been read yet, which is never a shortfall the
// caller can name.
export function budgetShortfall(plan, t) {
  if (!t) return null;
  const need = toCents(plan.budget);
  if (need === null || (Number.isFinite(t.usdtAvail) && t.usdtAvail >= need / 100)) return null;
  const have = Number.isFinite(t.usdtAvail) ? `free USDT ${usd(t.usdtAvail)}` : 'free USDT could not be read, so it counts as too little';
  return `${have}, below the ${plan.budget} USDT this buy needs.`;
}

// The one reason a period would buy nothing at all, checked in the same order buyPeriod (buy.mjs) checks it: an
// unreadable coin, an only-these coin not held, no coin in loss, every coin below OKX's minimum order, or free
// USDT below the budget. null when the period would in fact buy. One reader for buyPeriod and the dry run (rule 3,
// one fact one reader): before this, the dry run checked only the budget, so a day with both no coin in loss and
// free USDT below budget had the dry run name the budget and the real run name the empty loss list (review
// finding, buy.mjs:442, index 10(b)).
export function noBuyReason(plan, t) {
  if (!t.inPlan.length) {
    const unreadable = unreadableLine(t.out);
    if (unreadable) return { reason: unreadable, severity: 'problem' };
    const notHeld = notHeldLine(t.out);
    if (notHeld) return { reason: notHeld, severity: 'problem' };
    // Review finding (today.mjs:26, should): a coin whose pair is listed but not live is in loss just the same;
    // "no coin in the plan is in loss" is false for it, the same class as an unreadable figure or a not-held coin.
    const notLive = pairNotLiveLine(t.out);
    if (notLive) return { reason: notLive, severity: 'problem' };
    // Review finding (cards.mjs:84, should): an only-these list whose every named coin was left out for a
    // configuration reason (a stablecoin, no USDT pair, or USDT itself) never reached the loss check at all; a
    // plan with no --only never raises this, since a portfolio full of stablecoins is not a config mismatch.
    // Review finding (cards.mjs, should): this must raise the config reason only when EVERY only-coin is
    // config-excluded, as the comment above always said. It used to fire on any single one, so --only BTC,USDC
    // with BTC merely in profit named USDC's stablecoin status as the cause, although BTC being in profit is what
    // actually decided this was a no-loss day. With some but not all only-coins config-excluded, the day is still
    // a quiet no-loss one; the config mismatch is still worth a mention, just not the escalation.
    if (plan.only) {
      const config = configExcludedLine(t.out);
      if (config && configExcludedCoins(t.out).length === plan.only.length) return { reason: config, severity: 'problem' };
      if (config) return { reason: `no coin in the plan is in loss. ${config}`, severity: 'info' };
    }
    return { reason: 'no coin in the plan is in loss.', severity: 'info' };
  }
  // Review finding (cards.mjs:87, later): a coin left out for an unreadable figure or a not-held coin was already
  // shown here (buy.mjs's own leftOut, on a day that buys); the all-dropped and the shortfall reasons below never
  // named it at all, although it is in loss just the same and got no share of its own. Named the same way
  // (rule 3), and "every coin in loss" becomes "every readable coin in loss" once there is one to name, since the
  // unreadable or not-held coin was never counted among the shares that got dropped.
  const extra = [unreadableLine(t.out), notHeldLine(t.out), pairNotLiveLine(t.out)].filter(Boolean).join(' ');
  const withExtra = (reason) => (extra ? `${reason} ${extra}` : reason);
  if (!t.shares.length) {
    const readable = extra ? 'readable ' : '';
    return { reason: withExtra(`every ${readable}coin in loss had a share below OKX's minimum order size (${t.dropped.map((d) => d.ccy).join(', ')}).`), severity: 'problem' };
  }
  const shortfall = budgetShortfall(plan, t);
  return shortfall ? { reason: withExtra(shortfall), severity: 'problem' } : null;
}

// only: the plan's own --only list (or null/undefined), read the same way noBuyReason does: a portfolio full of
// stablecoins or no-pair coins is not a config mismatch for an ordinary plan, only for an only-these one.
export function splitLines(t, only = null) {
  const lines = [];
  // Finding 1 of the 2026-09-27 release-readiness review: while any coin was left out for an unreadable figure,
  // "no coin is in loss" has nothing behind it (and is false for a coin left out for its price, which already read
  // as in loss). The Left out line below names each such coin and its reason.
  if (!t.inPlan.length) {
    // Review finding (holdings.mjs:106): an only-these coin this account does not hold at all is the same kind of
    // "nothing behind this claim" case as an unreadable figure, not a genuine no-loss day.
    // Review finding (cards.mjs:84, should): the same is true of an only-these coin left out for a configuration
    // reason (a stablecoin, no USDT pair, or USDT itself), only when the plan actually is an only-these one.
    lines.push(unreadableCoins(t.out).length || notHeldCoins(t.out).length || pairNotLiveCoins(t.out).length || (only && configExcludedCoins(t.out).length)
      ? '  No coin in the plan can be bought right now, so it would buy nothing.'
      : '  No coin in the plan is in loss right now, so it would buy nothing.');
  }
  else if (!t.shares.length) lines.push("  Every coin in loss has a share below OKX's minimum order size, so it would buy nothing.");
  for (const s of t.shares) lines.push(`  ${s.ccy.padEnd(6)} -${s.lossPct.toFixed(2)}%  ${centsStr(s.cents)} USDT`);
  const dropLine = droppedLine(t.dropped, t.shares.length > 0);
  if (dropLine) lines.push(`  ${dropLine}`);
  if (t.out.length) {
    const byWhy = new Map();
    for (const c of t.out) {
      if (!byWhy.has(c.why)) byWhy.set(c.why, []);
      byWhy.get(c.why).push(c.ccy);
    }
    const groups = [...byWhy.entries()].map(([why, ccys]) => `${ccys.join(', ')} (${why})`);
    lines.push(`  Left out: ${groups.join('; ')}.`);
  }
  return lines;
}

export const RISK_LINE = "Buying a coin in loss lowers its average cost. It also raises that coin's share of your account; if it keeps falling, the loss in dollars grows.";
export const NO_END_LINE = 'No end date and no total cap: it runs until you ask your agent to stop it. A period with too little free USDT is skipped, never part-bought.';
// Section 10: shown on the card only for an hourly plan.
export const HOURLY_LINE = "Hourly: 24 buys a day. A small budget split across coins often falls below OKX's minimum order, so fewer coins are bought; with notify or mail at level all, each buy sends a message.";

// Review findings (cards.mjs:163, should and later): whether a plan (the card being shown, or the one just
// confirmed) replaces a different plan on record, restarts that SAME plan (same id, still running), or restarts a
// HALTED plan of its own id, read the same way by the card and the receipt (rule 3, one fact one reader) so the
// receipt can never say a plan replaces itself the way it used to whenever the card's own settings hashed to the
// running or halted plan's own id. null when no plan is on record at all.
export function restartKind(p, running) {
  if (!running) return null;
  if (running.id !== p.id) return 'replaces';
  return running.halted ? 'restartsHalted' : 'restartsSame';
}

// Review findings (cards.mjs:163, should and later): a same-id restart (restartsSame or restartsHalted alike)
// re-anchors a days:N cadence's own count from today, which can move its next buy day. Read by the card, before
// AVGPLAN, and by the receipt after it (rule 3, one fact one reader), so the two never say this two different ways
// and the card, the consent screen, says it before the receipt ever could. null whenever there is nothing to say:
// not a days:N cadence, no running/halted plan to restart, or today is already the old schedule's own next buy
// day, in which case re-anchoring changes nothing (rule 2, never state a cause that did not happen).
// today: the local date (plan.mjs's localParts) the restart lands on, a plain 'YYYY-MM-DD' string.
export function daysShiftLine(cadence, running, today) {
  if (!cadence || cadence.kind !== 'days' || !running || !running.anchorDate || !today) return null;
  let oldNext = today;
  for (let i = 0; i < cadence.n; i += 1) {
    if (isBuyDay({ date: oldNext }, cadence, running.anchorDate)) break;
    const d = new Date(`${oldNext}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    oldNext = d.toISOString().slice(0, 10);
  }
  if (oldNext === today) return null;
  return ` Its every-N-days count restarts from today (${today}), so its next buy moves from ${oldNext} to today.`;
}

// running: the plan already active on this account (planview.activePlan), or null. Named above the AVGPLAN line
// only when one exists and it is not the very plan this card would start. config: the account's own config.json
// (readConfigSafe's own return), read by the caller; mailLine reads the mail block out of it, defaulting to off
// when the caller has none to pass, so an older call site never fails to import for a card that used to have no
// mail line at all. ownerTest: preflight's own flag, read by the caller, so the card can print the same Builder
// Code disclosure the receipt and doctor print (item 4 of the 2026-09-27 release audit, guards.mjs's builderDisclosure).
// ip: preflight's own account/config ip field, read by the caller, so the card can warn about OKX's own key
// inactivity rule the same way doctor does (item 6, guards.mjs's keyInactivityWarning).
// refusal: the sentence confirm would refuse AVGPLAN with right now (plan.mjs's confirmRefusal), read by the
// caller from the same ledger the card itself was built from, or null when confirm would not refuse (review
// finding, cards.mjs:164, later: the card used to invite AVGPLAN even when confirm was certain to refuse it).
// today: the local date this card is shown on (plan.mjs's localParts), or null; passed only so a same-id restart
// of a days:N cadence can name its own re-anchor (daysShiftLine above) before the user ever types AVGPLAN. A
// caller with no use for that (most tests) simply omits it, and the card reads exactly as it did before.
// The consent screen must say that AVGPLAN also changes the computer's own scheduler. platform is the card's own
// (plan.mjs passes ctx.platform), or null when the caller does not know it: then both forms are named.
export function scheduleEntryLine(platform) {
  const form = platform === 'darwin' ? 'launchd'
    : platform ? 'a marked crontab entry'
      : 'launchd on macOS, a marked crontab entry on Linux';
  return `Typing AVGPLAN also adds AvgKeeper's own schedule entry on this computer (${form}); stop removes it.`;
}

export function planCard(p, mode, t, running = null, config = {}, ownerTest = false, ip = null, refusal = null, today = null, platform = null) {
  const cadence = parseCadence(p.cadence);
  const keyWarning = keyInactivityWarning(ip, cadence);
  // Review finding (buy.mjs:442): a real buy right now would skip on free USDT alone, whatever the split above
  // shows; named here so the card never implies today's buy would go through when it would not.
  //
  // Review finding (cards.mjs:146, later): this used to call budgetShortfall directly, whatever else was true. On
  // a day with no coin in loss AND free USDT below budget, noBuyReason (the one reader buyPeriod and the dry run
  // both use, rule 3) skips for "no coin in the plan is in loss", never the budget; splitLines above already says
  // so ("so it would buy nothing"), the same as it does for every coin below OKX's minimum. The budget line is the
  // one case splitLines does not already cover by itself, so it is shown only then, from the same reader, never a
  // second reason that contradicts the real run's own.
  const skip = t.inPlan.length && t.shares.length ? noBuyReason(p, t) : null;
  // Review findings (cards.mjs:163, should and later): the card named the plan it would replace only when the ids
  // differed. A card with the SAME settings as the plan on record (same id) said nothing at all, even when that
  // plan is halted with an order the halt asked the user to check (the spec says a halt lasts "until the user
  // checks status and restarts"), or when confirming it would re-anchor a days:N cadence's own buy days with no
  // word (finding, manage.mjs:201/cards.mjs:163, paths lens). The receipt (plan.mjs) must never say a plan
  // replaces itself either; both read this same line now (rule 3, one fact one reader).
  const kind = restartKind(p, running);
  // Review findings (cards.mjs:163, should and later): a restart (same id, healthy or halted) re-anchors a
  // days:N cadence's own count the same way either way; named here, before AVGPLAN, from the one shared helper
  // the receipt reads too (rule 3, one fact one reader).
  const shift = (kind === 'restartsSame' || kind === 'restartsHalted') ? (daysShiftLine(cadence, running, today) || '') : '';
  // Review finding (cards.mjs:164, later): planLine always ends in a period; wrapped in parentheses unchanged, the
  // sentence read "...split equally.)", a period stranded before the closing paren. Dropped here, the same way
  // mailReachLine already drops it (mail.mjs).
  const restartLine = {
    replaces: () => `This replaces the ${running.halted ? 'halted' : 'running'} plan ${running.id} (${planLine(running).slice(0, -1)})`,
    restartsHalted: () => `This restarts the halted plan: ${running.halted}${shift}`,
    restartsSame: () => `This is the running plan's own settings: confirming it restarts the plan, it does not start a new one.${shift}`,
  }[kind]?.() || null;
  // Review finding (cards.mjs:164, later): the card ended "To start it, type AVGPLAN" even when confirm is certain
  // to refuse it (an unsettled send on the account, or a torn ledger); refusal is that same message, in confirm's
  // own words (plan.mjs's confirmRefusal), or null when confirm would not refuse for either reason.
  const ending = refusal
    ? [`AVGPLAN would be refused right now: ${refusal}`]
    : [scheduleEntryLine(platform), 'To start it, type AVGPLAN. This card is good for 30 minutes.'];
  return [
    `AvgKeeper plan (${mode}, profile ${p.profile})`,
    planLine(p),
    coinsLine(p),
    ...(cadence && cadence.kind === 'hour' ? [HOURLY_LINE] : []),
    'If it ran now:',
    ...splitLines(t, p.only),
    ...(skip ? [`Right now it would skip: ${skip.reason}`] : []),
    `Spend: about ${usd(monthlyUsdt(p))} USDT a month from your free USDT (now ${usd(t.usdtAvail)}). Every buy spends free USDT, so less is left for anything else you run on this account.`,
    RISK_LINE,
    NO_END_LINE,
    builderDisclosure(ownerTest),
    ...(keyWarning ? [keyWarning] : []),
    mailLine(config),
    // Review finding (manage.mjs:81, rule 4): a halted plan buys nothing; calling it "the running plan" the same
    // as a healthy one this card would replace said the opposite.
    ...(restartLine ? [restartLine] : []),
    ...ending,
  ];
}
