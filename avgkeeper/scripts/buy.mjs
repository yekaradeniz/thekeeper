// avgkeeper/scripts/buy.mjs
// buy: the scheduled run, and the only path that sends an order with no word typed in the same session. Every rule
// below fails closed: a buy whose result is unknown halts the plan until the user makes a new one.
import {
  activePlan, unsettledSends, modeOf, tornWarning, markSendsUnknown, buyLockName, LOCK_HELD_LINE, staleLockLine, timeZoneWarning, stalePeriods,
} from './planview.mjs';
import { dueNow } from './period.mjs';
import { todaySplit, readAccount } from './today.mjs';
import { unreadableLine, notHeldLine, pairNotLiveLine } from './holdings.mjs';
import {
  preflight, gHandRun, gSchema, BUILDER_CODE, OKX_KEY_RULE, isNoKeySavedFailure, noKeySavedLine, NO_CLI_LINE,
} from './guards.mjs';
import {
  buyClOrdId, placeArgs, sendBuy, readOrder, fillOf, stillOnTheBook, orderName,
} from './orders.mjs';
import { tell } from './notify.mjs';
import { toCents, centsStr } from './decimal.mjs';
import { usd } from './units.mjs';
import { reasonOf, isRetryable } from './runner.mjs';
import {
  planLine, splitLines, droppedLine, noBuyReason,
} from './cards.mjs';

export const READ_BACK_TRIES = 3;
export const READ_BACK_GAP_MS = 2000;
// OKX's 51603 proves only "not found now": a timed-out order can land seconds later, and OKX drops a cancelled
// order that never filled after about 2 hours. A later run settles a not-found send as nothing spent only once the
// send is at least this old.
export const NOT_FOUND_SETTLE_MS = 2 * 3600000;
export const DRY_SUMMARY = 'buy: dry run, nothing sent.';

const acct = (call) => ({ profile: call.profile, env: modeOf(call) });
// What a mail notice needs to know about the plan an event belongs to (spec section 9: the body carries the plan
// line). One helper, so no tell() call site can pass the plan id and forget the plan line. life: this incarnation
// of the plan's own plan_active ts (planview.mjs's planLifeStart reads the same field), so mail.mjs can scope a
// period-less notice id to the plan's own life (review finding, mail.mjs:307, should): a plan id is a hash of the
// plan's settings alone, so a plan remade with identical settings shares its earlier, ended life's own id, and an
// auth halt with no period of its own would otherwise fall back to the local date alone and collide with an
// earlier life's halt on the same day.
const about = (plan, kind, period = null, more = {}) => ({
  kind, planId: plan.id, period, planLine: planLine(plan), life: plan.ts, ...more,
});

// Why a read before any order was sent failed, as a skip reason. An auth failure is not a skip: the caller halts.
// A plain REFUSED error (the plan's own record, a duplicate balance row) keeps its own words; anything else is OKX.
// Review finding (buy.mjs:40): an env mismatch (runner.mjs's envMismatch, kind 'env') already reads OKX; the
// account it answered for was the wrong one. That is not "OKX could not be read", so its own REFUSED sentence is
// kept as-is, the same as a plan whose own record cannot be read, whatever kind carries it.
// Review findings (buy.mjs:45, later): a missing okx CLI (kind 'missing', typically an nvm or Homebrew upgrade
// that removed it, the exact risk doctor's own version-path warning names) means OKX was never called at all, a
// different fact from an OKX read that failed. failureLine (guards.mjs) already has NO_CLI_LINE for it, and the
// dry run already prints that sentence (guards.mjs's failureLine, via preflight's own refusal path); the scheduled
// skip now says the same thing instead of the generic "OKX could not be read" (rule 3, one fact one reader).
function skipReason(e) {
  if (/^REFUSED: /.test(String(e.message))) return e.message.replace(/^REFUSED: /, '');
  // Review finding (buy.mjs:56, later): NO_CLI_LINE already opens with "AvgKeeper", and the skip line this
  // reason feeds ("AvgKeeper skipped <period>: ...") opens with it too, so the word doubled. Reinstalling the CLI
  // alone does not fix the realistic trigger this comment already names (an nvm or Homebrew upgrade that moved
  // node or the CLI out from under a schedule line installed against the old path); doctor's own scheduleRisks
  // already names the actual fix, so it is named here too.
  if (e.kind === 'missing') return `${NO_CLI_LINE.replace(/^AvgKeeper /, '')}. If a node or okx upgrade moved it, run doctor again and reinstall the schedule line it prints.`;
  return `OKX could not be read (${reasonOf(e)}).`;
}

export async function buyVerb(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const dry = Boolean(o['dry-run']);
  const hand = gHandRun(ctx.env, dry);
  if (hand) {
    ctx.out(hand.msg);
    return 1;
  }
  // Each line below is printed, notified and mailed as one variable: the screen and the mail never have two
  // authors (research doc rule 2).
  let ledger;
  try {
    ledger = ctx.store.readLedger();
  } catch (e) {
    const line = `AvgKeeper could not read its own records, so it bought nothing: ${e.message}`;
    ctx.out(line);
    // Review finding (buy.mjs:64, later): SKILL.md lists the dry run as a READ that "Sends nothing"; the torn-
    // ledger and newer-schema branches below already guard tell() with `if (!dry)`, this one did not.
    if (!dry) await tell(ctx, call, 'problem', line, { kind: 'halt' });
    return 1;
  }
  // A skipped line can be the plan_halted or plan_stopped that ends a plan: read past it and the plan comes back.
  // No run buys over a ledger it could not read in full; the dry run refuses too, so smoke fails the same way.
  if (ledger.torn) {
    const line = `AvgKeeper bought nothing: ${tornWarning(ledger, ctx.store.home)}`;
    ctx.out(line);
    if (!dry) await tell(ctx, call, 'problem', line, { kind: 'halt' });
    return 1;
  }
  // A ledger a newer AvgKeeper copy already wrote to may hold line kinds this copy cannot read: refused here, before
  // this copy ever reaches OKX, not only inside preflight's own gSchema check.
  const schemaRefusal = gSchema(ledger, ctx.store.home);
  if (schemaRefusal) {
    const line = `AvgKeeper bought nothing: ${schemaRefusal.msg}`;
    ctx.out(line);
    if (!dry) await tell(ctx, call, 'problem', line, { kind: 'halt' });
    return 1;
  }
  const plan = activePlan(ledger, call);
  if (dry) return dryRun(ctx, call, plan);
  if (!plan) {
    ctx.out('No AvgKeeper plan is running on this profile. Nothing to buy.');
    return 0;
  }
  if (plan.halted) {
    ctx.out(`The plan is halted: ${plan.halted} Nothing is bought until you make a new plan.`);
    return 0;
  }
  const tz = timeZoneWarning(plan, ctx.timeZone);
  if (tz) {
    const line = `AvgKeeper: ${tz}`;
    ctx.out(line);
    await tell(ctx, call, 'problem', line, about(plan, 'tz'));
  }
  const due = dueNow(ctx.now(), plan, ledger);
  // Findings (buy.mjs:231, buy.mjs:256): a stale period (every send settled, still no period_done) also has to
  // take the lock and reach resolveOpen, the same as an unsettled send does, or a run that died right after its
  // last coin settled cleanly is never closed at all.
  if (!due.due && !unsettledSends(ledger, plan.id).length && !stalePeriods(ledger, plan).length) {
    ctx.out(`Nothing to buy now: ${due.why}.`);
    return 0;
  }
  // takeover false: a live run past LOCK_STALE_MS can still be mid-send; taking its lock could send a buy twice.
  const release = ctx.store.lock(buyLockName(call), { takeover: false });
  if (!release) {
    const stale = staleLockLine(ctx.store, call);
    if (stale) {
      ctx.out(stale);
      await tell(ctx, call, 'problem', stale, about(plan, 'lock', due.period || null));
      return 1;
    }
    ctx.out(`${LOCK_HELD_LINE} This run bought nothing.`);
    return 0;
  }
  try {
    return await locked(ctx, call, plan.id);
  } finally {
    release();
  }
}

async function locked(ctx, call, planId) {
  const ledger = ctx.store.readLedger();
  const plan = activePlan(ledger, call);
  if (!plan || plan.id !== planId || plan.halted) {
    ctx.out('The plan changed while this run waited. Nothing was bought.');
    return 0;
  }
  // Review finding (buy.mjs:148, should): declared here, outside the try block, so the catch below can still read
  // it. An auth failure thrown from inside buyPeriod (a later coin's pre-send check, its send or its read-back)
  // used to reach halt() with no period at all, because `due` was out of scope by the time the catch ran: the halt
  // notice then carried no detail line for a coin that period had already filled (spec section 9, buy.mjs:160).
  let due = null;
  try {
    if ((await resolveOpen(ctx, call, plan, ledger)) === 'halt') return 1;
    const after = ctx.store.readLedger();
    due = dueNow(ctx.now(), plan, after);
    if (!due.due) return 0;
    // After a money move whose outcome is unknown, the system never continues by itself (spec section 5): a send
    // still waiting after the read-back keeps this period from buying at all.
    const waiting = unsettledSends(after, plan.id);
    if (waiting.length) {
      return skip(ctx, call, plan, due.period, `an earlier order's result is not known yet (${waiting.map((s) => s.clOrdId).join(', ')}); the next run reads it again.`);
    }
    return await buyPeriod(ctx, call, plan, due.period);
  } catch (e) {
    if (e.kind === 'auth') {
      // Item 6 of the 2026-09-27 release audit: a hedge, not a diagnosis (ProjectBuilder CLAUDE.md rule 2). This
      // run never read whether the key had an IP bound before the key itself stopped answering, so the halt names
      // OKX's own rule as one thing that can cause this, never as the cause.
      //
      // Review finding (buy.mjs:145, probe K1): the okx CLI having no key saved locally at all is a different
      // failure from OKX rejecting a key it did see: OKX was never called, so neither "OKX did not accept" nor its
      // 14-day deletion rule is a cause this run checked. holdings already tells the two apart (rule 3).
      const reason = isNoKeySavedFailure(e)
        ? noKeySavedLine(call.profile)
        : `OKX did not accept API key ${call.profile} (${reasonOf(e)}). ${OKX_KEY_RULE} If this key has no IP address bound to it, that rule is one possible cause; check the key on the OKX website.`;
      await halt(ctx, call, plan, reason, due && due.due ? due.period : null);
      return 1;
    }
    throw e;
  }
}

// Every send of this plan still unsettled when it halts is recorded unknown and named, so the halted plan never
// holds the account: plan confirm refuses while a send is unsettled, and a halted plan reads nothing back again.
// period is the buy period this halt belongs to when the caller has one (settle() always does); an auth failure
// caught outside any single send's scope (locked()'s own catch) has none, and the mail notice falls back to the
// local date, same as the other pre-plan failures above. ownUnknown: { base, error } for the one send whose own
// unreadable outcome triggered this halt, not yet written to the ledger. Review finding, buy.mjs:157: plan_halted
// is this function's own first write, before this send's own buy_unknown and before every other open send's, so a
// crash right after it still leaves the plan halted (fail closed). The old order wrote every open send's
// buy_unknown first and plan_halted last, so a crash partway through marking several open sends left them settled
// unknown on a plan the ledger still showed as active, free to buy again the next period (spec section 5: after a
// money move whose outcome is unknown, the system never continues by itself). New regression: both ledger writes
// below must land before tell() ever runs, not after: the notify command can take up to NOTIFY_TIMEOUT_MS and the
// mail command another, and a run killed in that window used to leave a halted plan holding a send the ledger
// never marked unknown, with waitingLine (planview.mjs) then wrongly promising a read-back that a halted plan
// never makes.

// The plain "<ccy> <usd> USDT" list of what a period's own buy_filled lines already add up to, the same style
// buyPeriod's own summary (`bought`, below) already uses. Read here so halt() can say what a period bought before
// it halted (spec section 9), without a second copy of that formatting.
function filledSoFar(ledger, planId, period) {
  return ledger.filter((e) => e.kind === 'buy_filled' && e.planId === planId && e.period === period)
    .map((e) => `${e.instId.replace('-USDT', '')} ${usd(e.notional)} USDT`);
}

async function halt(ctx, call, plan, reason, period = null, ownUnknown = null) {
  // Review finding (buy.mjs:213, later): this read runs before plan_halted is ever written; halt() is built to
  // always write plan_halted even when a ledger read fails (the unsettledSends read just below already guards
  // itself the same way), so a failure here must name nothing rather than stop halt() from ever marking the plan
  // halted at all.
  if (period) {
    let filled = [];
    try {
      filled = filledSoFar(ctx.store.readLedger(), plan.id, period);
    } catch {
      filled = [];
    }
    if (filled.length) reason = `${reason} Before it halted, this period bought: ${filled.join(', ')}.`;
  }
  let open = [];
  try {
    open = unsettledSends(ctx.store.readLedger(), plan.id);
  } catch {
    open = [];
  }
  if (ownUnknown) open = open.filter((s) => s.clOrdId !== ownUnknown.base.clOrdId);
  if (open.length) reason = `${reason} Check order(s) in the OKX app: ${open.map((s) => orderName(s.instId, s.amount, s.period, s.clOrdId)).join(', ')}.`;
  // period, named here too (not only in the mail notice's own `about`): closeStalePeriods (further down) reads it
  // back through activePlan (planview.mjs's haltedPeriod) so it never treats a halted plan's own halt period as one
  // more stale period to close (review finding, should).
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, period, ...acct(call), reason }, ctx.now());
  if (ownUnknown) ctx.store.appendLedger({ kind: 'buy_unknown', ...ownUnknown.base, error: ownUnknown.error }, ctx.now());
  markSendsUnknown(ctx.store, call, plan.id, 'the plan halted before this order was read back', ctx.now());
  const line = `AvgKeeper HALTED: ${reason} Nothing more is bought until you make a new plan.`;
  ctx.out(line);
  await tell(ctx, call, 'problem', line, about(plan, 'halt', period));
}

async function skip(ctx, call, plan, period, reason, severity = 'problem') {
  ctx.store.appendLedger({ kind: 'period_skipped', planId: plan.id, period, ...acct(call), reason }, ctx.now());
  const line = `AvgKeeper skipped ${period}: ${reason}`;
  ctx.out(line);
  await tell(ctx, call, severity, line, about(plan, 'skip', period));
  return 0;
}

// The decision settle() makes for a read-back, and the one previewSettle (the dry run) reads too: no ctx, no I/O, no
// ledger write, so both callers are reading the same fact instead of keeping their own copy of this branch tree
// (rule 3, one fact one reader; the blocker this closes: previewSettle used to read fillOf's 'unreadable' kind as
// 'resolves' while settle() halts on it, promising a split the real run then halted on). got and sentAs are exactly
// settle()'s own arguments of the same names; ageMs is settle()'s own age computation, passed in rather than
// computed here so this function never touches ctx.now(). decision is exactly the string settle() itself returns
// once its side effects run ('halt', 'wait', 'rejected' or 'filled'); kind tells settle() which of that decision's
// message templates and ledger fields to use (send's own instId/amount/period/clOrdId, needed for orderName() in
// every halt sentence, are not passed in here, so settle() builds the final sentence itself); state and why carry
// the raw facts those templates need; money carries fillOf's result for a 'filled' decision.
export function settleVerdict(got, sentAs, ageMs) {
  if (got.notFound) {
    if (sentAs === 'accepted') return { decision: 'halt', kind: 'notFoundAccepted' };
    if (sentAs !== 'later' || !(ageMs >= NOT_FOUND_SETTLE_MS)) return { decision: 'wait', kind: 'notFoundWait' };
    return { decision: 'rejected', kind: 'notFoundRejected' };
  }
  if (got.network) return { decision: 'wait', kind: 'network' };
  if (!got.row) return { decision: 'halt', kind: 'noRow' };
  // stillOnTheBook is checked here before fillOf is ever called, so fillOf's own 'pending' kind (it makes the same
  // check internally, for a caller that reads a row with no send of its own) never reaches this function.
  if (stillOnTheBook(got.row)) return { decision: 'wait', kind: 'stillOnTheBook' };
  const money = fillOf(got.row);
  // A state OKX has not documented as final (or none at all) is not proof the order is finished (rule 2), but by
  // this point stillOnTheBook has already ruled out live and partially_filled, so it is not a row still settling
  // either. Review finding, buy.mjs:212, fixed the first half by never inventing a fill here; the second half
  // (waiting forever, with no time limit and no halt) is a regression that fix introduced, closed the same way any
  // other unreadable answer already is: halt, so the plan stops instead of skipping every later period twice over
  // with no way out but the OKX app.
  if (money.kind === 'pending') return { decision: 'halt', kind: 'pending', state: got.row.state };
  if (money.kind === 'none') return { decision: 'rejected', kind: 'none', state: got.row.state };
  // Review findings (buy.mjs:538, blocker): settle() halts on fillOf's 'unreadable' kind too, a finished order whose
  // own filled size or price cannot be read. previewSettle used to treat only 'pending' as a halt, so a
  // finished-but-unreadable fill made the dry run promise a split the very next real run would in fact halt on.
  if (money.kind === 'unreadable') return { decision: 'halt', kind: 'unreadable', why: money.why };
  return { decision: 'filled', kind: 'filled', money };
}

// Records what a read-back says. 'filled', 'rejected', 'wait' (still on the book or not readable right now) or
// 'halt' (an answer AvgKeeper cannot turn into money spent). sentAs says what the send this run made answered:
// 'accepted', 'unknown', or 'later' for a send an earlier run made (resolveOpen). It decides what "not found" means.
//
// Review finding (buy.mjs:31, should): a 'wait' result used to be the bare string 'wait', so every caller had to
// keep its own second copy of what to say about it (the module-level WAIT_LINE), one vaguer sentence for every one
// of the three 'wait' causes even though this function already knows, and already prints, which one it is. A
// 'wait' result now carries that same sentence (waitLine) as its own field, so the summary and the resolve line
// build from the one place this fact is decided (rule 3, one fact one reader), never a second guess at it.
async function settle(ctx, call, plan, send, got, sentAs) {
  const base = {
    planId: plan.id, period: send.period, instId: send.instId, clOrdId: send.clOrdId, amount: send.amount, ...acct(call),
  };
  const age = ctx.now() - Date.parse(send.ts);
  const v = settleVerdict(got, sentAs, age);
  const wait = (waitLine) => {
    ctx.out(`${send.instId}: ${waitLine}`);
    return { result: 'wait', waitLine };
  };
  if (v.kind === 'notFoundAccepted') {
    const error = 'OKX accepted the order, then had no order with this id';
    await halt(ctx, call, plan, `OKX accepted the ${orderName(send.instId, send.amount, send.period, send.clOrdId)} buy, then had no order with its id. Check it in the OKX app.`, send.period, { base, error });
    return { result: 'halt' };
  }
  if (v.kind === 'notFoundWait') return wait('OKX has no order with this id yet. It can still land, so the next run reads it again.');
  if (v.kind === 'notFoundRejected') {
    ctx.store.appendLedger({ kind: 'buy_rejected', ...base, sCode: null, sMsg: 'OKX has no order with this id' }, ctx.now());
    ctx.out(`${send.instId}: OKX has no order with this id, at least 2 hours after the send. Nothing spent on it.`);
    return { result: 'rejected' };
  }
  if (v.kind === 'network') return wait(`the order could not be read back yet (${got.error}). The next run reads it again.`);
  if (v.kind === 'noRow') {
    await halt(ctx, call, plan, `the ${orderName(send.instId, send.amount, send.period, send.clOrdId)} buy could not be read back (${got.error}). Check it in the OKX app.`, send.period, { base, error: got.error });
    return { result: 'halt' };
  }
  if (v.kind === 'stillOnTheBook') return wait('the order is still open on OKX. The next run reads it again.');
  if (v.kind === 'pending') {
    // Review finding (buy.mjs:251, later): the old wording spliced the state in as "answered with its own state
    // ((none)) is not one OKX documents as finished", ungrammatical (a missing "which") and double-parenthesised
    // when there was no state at all. Each branch below reads as one plain clause instead.
    const error = v.state
      ? `state ${v.state}, which OKX does not document as finished`
      : 'no state at all';
    await halt(ctx, call, plan, `the ${orderName(send.instId, send.amount, send.period, send.clOrdId)} buy answered with ${error}, so AvgKeeper cannot say what it spent. Check it in the OKX app.`, send.period, { base, error });
    return { result: 'halt' };
  }
  if (v.kind === 'none') {
    ctx.store.appendLedger({ kind: 'buy_rejected', ...base, sCode: null, sMsg: `finished in state ${v.state || '(none)'} with nothing filled` }, ctx.now());
    ctx.out(`${send.instId}: the order finished without filling. Nothing spent on it.`);
    return { result: 'rejected' };
  }
  if (v.kind === 'unreadable') {
    await halt(ctx, call, plan, `the ${orderName(send.instId, send.amount, send.period, send.clOrdId)} buy finished and ${v.why}, so AvgKeeper cannot say what it spent. Check it in the OKX app.`, send.period, { base, error: v.why });
    return { result: 'halt' };
  }
  ctx.store.appendLedger({
    kind: 'buy_filled', ...base, notional: v.money.notional, accFillSz: got.row.accFillSz, avgPx: got.row.avgPx, fee: got.row.fee || null, feeCcy: got.row.feeCcy || null,
  }, ctx.now());
  return { result: 'filled' };
}

// Writes period_done for one of this plan's own stale periods (planview.mjs's stalePeriods: every buy_sent of the
// period already settled, still no period_done) and returns its own "stopped partway" line and the clOrdIds it
// filled. The one builder for this fact (rule 3, one fact one reader), shared by resolveOpen below (the next
// scheduled run of the same plan life) and closeStalePeriods further down (stop and plan confirm ending a plan's
// life out from under a period their own run never revisits).
// ts: the timestamp this write gets. Review findings (plan.mjs:187, period.mjs:216, should): this used to call
// ctx.now() itself, and a same-id confirm (planId0, an identical settings hash to the plan it replaces) calls this
// before writing the new plan_active with the `now` it already captured. The two calls can read the very same
// clock (a fixed clock in a test, or a real one that has not ticked between them), so this closing line's own ts
// could land no earlier than the new life's own start, and lastRun's strict "< since" life filter then counted an
// older life's own closed-out period as this new one's own Last run. Every caller now passes its own ts explicitly.
function closeStalePeriod(ctx, call, plan, ledger, period, ts) {
  // Review finding (buy.mjs:312, later): "OKX confirmed it never received" states more than a 51603 answer proves;
  // the fact actually checked is that nothing was spent, not that OKX never received the order at all.
  const notFoundSMsg = 'OKX has no order with this id';
  const neverLanded = new Set(ledger.filter((e) => e.kind === 'buy_rejected' && e.planId === plan.id && e.period === period && e.sMsg === notFoundSMsg).map((e) => e.clOrdId));
  const recorded = ledger.filter((e) => e.kind === 'buy_sent' && e.planId === plan.id && e.period === period && !neverLanded.has(e.clOrdId)).map((e) => e.instId);
  const filled = ledger.filter((e) => e.kind === 'buy_filled' && e.planId === plan.id && e.period === period).map((e) => e.clOrdId);
  ctx.store.appendLedger({ kind: 'period_done', planId: plan.id, period, ...acct(call) }, ts);
  const line = recorded.length
    ? `The run for ${period} stopped partway; it had recorded these orders: ${recorded.join(', ')}.`
    : `The run for ${period} stopped partway; OKX has no order with any of its ids, at least 2 hours after each send. Nothing was spent on them.`;
  return { line, filled };
}

// Review finding (manage.mjs:201, should, paths lens): a run that dies partway through a period leaves a stale
// period behind (a coin filled, no period_done, no notice). Before this, only the next scheduled run of the SAME
// plan life ever closed it (resolveOpen below, via stalePeriods); stop closed only unsettled sends, and plan
// confirm closed nothing, so money a stale period already spent never reached a mail with its details when the
// user stopped or remade the plan first (spec section 9: money spent reaches a mail with its details on every
// path). Shared with resolveOpen through closeStalePeriod above (rule 3, one fact one reader), so the two screens
// never word the same fact two ways. Returns the notice line printed, or null when there was nothing stale.
// now: this call's own ts for the period_done lines it writes (plan.mjs passes one strictly before the new plan's
// own ts on a same-id restart; see closeStalePeriod above). Defaults to ctx.now() for stopLocked's own call, which
// never writes a competing plan_active line afterward.
// Review finding (manage.mjs:365 area, should): a halted plan never writes period_done for its own halt period by
// design (halt() already sent its own notice with the same fill details), so that period always reads as stale
// here too. Excluded by the period the plan's own plan_halted line named (planview.mjs's activePlan), so this only
// ever closes a DIFFERENT, genuinely unresolved period of a halted plan.
export async function closeStalePeriods(ctx, call, plan, now = ctx.now()) {
  const stale = stalePeriods(ctx.store.readLedger(), plan).filter((period) => period !== plan.haltedPeriod);
  if (!stale.length) return null;
  const lines = [];
  const filled = [];
  for (const period of stale) {
    const { line, filled: pFilled } = closeStalePeriod(ctx, call, plan, ctx.store.readLedger(), period, now);
    lines.push(line);
    for (const id of pFilled) if (!filled.includes(id)) filled.push(id);
  }
  const notice = `AvgKeeper closed an earlier period: ${lines.join(' ')}`;
  ctx.out(notice);
  const period = stale.length === 1 ? stale[0] : null;
  await tell(ctx, call, 'problem', notice, about(plan, 'resolve', period, { clOrdIds: filled }));
  return notice;
}

// Reads back every send an earlier run left unsettled and notifies what it found in one line. A period whose sends it
// settled but that has no period_done belongs to a run that died partway: it gets its period_done here, and the
// notice names every order that run sent.
async function resolveOpen(ctx, call, plan, ledger) {
  const lines = [];
  const periods = new Set();
  // The orders this run settled as filled: the mail notice lists their fill details (size, price, notional), which
  // the one-word "filled." below does not carry.
  const filled = [];
  let problem = false;
  let halted = false;
  // New regression (buy.mjs:316): the stale-period close added for buy.mjs:256 reaches the notice below with no
  // read-back at all (nothing in the loop below to iterate: every send of the stale period already settled itself
  // before this run started). readAny is only ever set once this loop actually reads an order back, so the notice
  // never claims an action this run did not take (rule 2).
  let readAny = false;
  for (const send of unsettledSends(ledger, plan.id)) {
    readAny = true;
    const got = await readOrder(ctx, call, { instId: send.instId, clOrdId: send.clOrdId });
    const r = await settle(ctx, call, plan, send, got, 'later');
    const where = `${send.instId} for ${send.period}`;
    if (r.result === 'halt') {
      halted = true;
      break;
    }
    if (r.result === 'filled') {
      filled.push(send.clOrdId);
      lines.push(`${where}: filled.`);
    }
    if (r.result === 'rejected') lines.push(`${where}: did not go through. Nothing spent on it.`);
    if (r.result === 'wait') lines.push(`${where}: ${r.waitLine}`);
    if (r.result !== 'filled') problem = true;
    if (r.result === 'filled' || r.result === 'rejected') periods.add(send.period);
  }
  // Findings (buy.mjs:231, buy.mjs:256): a run that sent and settled its very last order, then died before ever
  // writing period_done, leaves no unsettled send at all: the loop above finds nothing, so nothing points at that
  // period. stalePeriods (planview.mjs) finds it by its own settled sends and missing period_done instead.
  if (!halted) {
    const fresh = ctx.store.readLedger();
    for (const period of stalePeriods(fresh, plan)) {
      // Finding 18, and review finding (buy.mjs:316, should): this period's own fills were settled by the run that
      // died, not by the loop above, so `filled` (the mail notice's own clOrdIds, spec section 9) would otherwise
      // stay empty for it and the money it spent would reach no mail detail line at all. Before this, that
      // gathering ran only for a period the loop above never touched at all; a period it DID touch, because one of
      // its other coins was still unsettled, skipped it, so a coin the dead run had already filled before it
      // crashed reached no mail detail line whenever a sibling coin of the same period needed reading back too.
      // Gathered here for every stale period, and deduped by clOrdId so a coin the loop itself already filled is
      // never listed twice.
      if (!periods.has(period)) problem = true;
      for (const e of fresh) {
        if (e.kind === 'buy_filled' && e.planId === plan.id && e.period === period && !filled.includes(e.clOrdId)) filled.push(e.clOrdId);
      }
      periods.add(period);
    }
  }
  if (!halted && periods.size) {
    const now = ctx.store.readLedger();
    for (const period of periods) {
      if (now.some((e) => e.kind === 'period_done' && e.planId === plan.id && e.period === period)) continue;
      // closeStalePeriod (above) is the one builder for this line and this write, shared with closeStalePeriods
      // (stop and plan confirm ending a plan's life out from under a period this run never revisits), so the two
      // never word the same fact two ways (rule 3, one fact one reader).
      const { line } = closeStalePeriod(ctx, call, plan, now, period, ctx.now());
      lines.push(line);
    }
  }
  if (lines.length) {
    const opener = readAny ? 'AvgKeeper read back earlier orders' : 'AvgKeeper closed an earlier period';
    const notice = `${opener}: ${lines.join(' ')}`;
    ctx.out(notice);
    // periods can hold more than one date only when a run died mid-period on one day and left an earlier day's
    // send open too; that mixed case has no single period to name, so the mail notice falls back to the local
    // date rather than picking one of several at random.
    const period = periods.size === 1 ? [...periods][0] : null;
    await tell(ctx, call, halted || problem ? 'problem' : 'info', notice, about(plan, 'resolve', period, { clOrdIds: filled }));
  }
  return halted ? 'halt' : 'ok';
}

async function readBack(ctx, call, instId, clOrdId) {
  let got;
  for (let i = 0; i < READ_BACK_TRIES; i += 1) {
    got = await readOrder(ctx, call, { instId, clOrdId });
    if (!(got.network || (got.row && stillOnTheBook(got.row)))) return got;
    if (i < READ_BACK_TRIES - 1) await ctx.sleep(READ_BACK_GAP_MS);
  }
  return got;
}

// OKX 54092: the account has to accept a disclaimer for this pair on the OKX website. It comes back every buy day
// with a 300-character message, so it gets one plain sentence instead.
export const DISCLAIMER_CODE = '54092';
export const SMSG_MAX = 120;

// Review finding (buy.mjs:418, later): an sMsg that opens with a generic clause of its own ("Order failed.
// Insufficient balance", the sibling product's own 51008 fixture, gridkeeper/tests/runner.test.mjs:321) lost its
// real cause: cutting at the first ". " read "Order failed" as the whole sentence. Skipped here, before the cut,
// so the cause behind it survives.
// Review finding (buy.mjs:480, later): "Order failed" with no dot at all but a following ": " (OKX sends both
// shapes) left the colon in place, since \.? only ever matched a literal dot; the very next split on /\. |: / then
// matched right at the string's own start, giving an empty first part and losing the cause all over again. [.:]?
// consumes either separator before the following \s*.
const GENERIC_LEAD = /^Order failed[.:]?\s*/i;

// The problem line for a rejected send: OKX's first sentence only, cut to SMSG_MAX characters.
export function rejectedLine(instId, rejected) {
  if (String(rejected.sCode) === DISCLAIMER_CODE) {
    return `${instId}: OKX requires you to accept a disclaimer for this pair on the OKX website before it can be bought by API. Nothing spent on it.`;
  }
  const first = String(rejected.sMsg || '').replace(GENERIC_LEAD, '').split(/\. |: /)[0].trim().slice(0, SMSG_MAX);
  return `${instId}: OKX rejected the buy (${first || rejected.sCode}). Nothing spent on it.`;
}

// Item 8 of the 2026-09-27 release audit: a launchd catch-up run right after wake can reach OKX before Wi-Fi has
// actually reconnected. Before this, one transient network failure here closed the whole period for good (skip()
// writes period_skipped, which period.mjs's periodTouched then blocks forever, even seconds later once the
// connection is back). This retries the read and never touches a WRITE: only a read a period needs before it ever
// sends anything, which is always safe to run again from scratch. Later item L1 of the 2026-09-27 release-readiness
// review: one retry 2 s later is short for Wi-Fi to rejoin, so it waits 10, 20 and 30 s between tries (about a
// minute in all). Only the two reads that open a run use it; readExisting below keeps one short retry per coin, so
// an outage mid-run cannot hold the buy lock for a minute per coin.
export const PRE_SEND_RETRY_WAITS_MS = [10000, 20000, 30000];
// Review finding (buy.mjs:315): a timeout (one okx call past 60 s, plausible right after wake) or a rate limit
// (the runner itself already retries one once, WITHOUT-write) is worth reading again later the same way a network
// failure is. isRetryable (runner.mjs) is the one reader for this fact, readOrder's own network flag (orders.mjs)
// and lastPrices' own rethrow (today.mjs) all share (review finding, buy.mjs:363: three separate copies of this
// set let a later edit widen or narrow it for only one of the three).
async function withNetworkRetry(ctx, fn) {
  for (const wait of PRE_SEND_RETRY_WAITS_MS) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e)) throw e;
    }
    await ctx.sleep(wait);
  }
  return fn();
}

// Item 7 of the 2026-09-27 release audit: one short retry, READ_BACK_GAP_MS later, for the one read that
// does not throw on a network failure at all (readOrder's own contract is `{ error, network }`, never a throw): a
// transient hiccup here used to drop the coin for the whole period with no retry and no durable trace of why.
async function readExisting(ctx, call, instId, clOrdId) {
  let got = await readOrder(ctx, call, { instId, clOrdId });
  if (got.network) {
    await ctx.sleep(READ_BACK_GAP_MS);
    got = await readOrder(ctx, call, { instId, clOrdId });
  }
  return got;
}

async function buyPeriod(ctx, call, plan, period) {
  let pre;
  try {
    pre = await withNetworkRetry(ctx, () => preflight(ctx, call));
  } catch (e) {
    if (e.kind === 'auth') throw e;
    return skip(ctx, call, plan, period, skipReason(e));
  }
  if (pre.refusals.length) return skip(ctx, call, plan, period, pre.refusals[0].msg.replace(/^REFUSED: /, ''));
  let t;
  try {
    t = await withNetworkRetry(ctx, () => todaySplit(ctx, call, plan));
  } catch (e) {
    if (e.kind === 'auth') throw e;
    return skip(ctx, call, plan, period, skipReason(e));
  }
  // Item 2 of the 2026-09-27 release audit, closed by finding 1 of the release-readiness review: any coin left out
  // only because OKX sent no readable figure for it leaves "no coin in the plan is in loss" with nothing behind
  // it, and a coin left out for its price is known to be in loss. An in-profit or dust coin beside it is no
  // evidence about it. So every such coin is named at problem severity, whatever the other coins are, and the
  // quiet info-level skip is kept only for a day with none. Review finding (holdings.mjs:106): an only-these coin
  // this account does not hold at all (a typo, or a coin sold off) is a config mismatch, not a quiet day with no
  // loss; it is named at problem severity too. Compared as parsed numbers, never rounded (budgetShortfall,
  // cards.mjs): rounding read 9.996 free as 10.00, and flooring x * 100 reads an exact 2.01 as 200 cents.
  // noBuyReason (cards.mjs) is the one reader for this whole gate, in this exact order: buyPeriod and the dry run
  // (review finding, buy.mjs:442, index 10(b): the two used to check the budget against a different order).
  const no = noBuyReason(plan, t);
  if (no) return skip(ctx, call, plan, period, no.reason, no.severity);
  const code = pre.ownerTest ? '' : BUILDER_CODE;
  const bought = [];
  // Item 2 of the 2026-09-27 release audit: a coin left out this period because OKX sent no readable figure for it
  // is named here too, on a day that does buy for the others, at problem severity, in the same words the skip line
  // above uses (holdings.mjs's unreadableLine).
  const leftOut = [unreadableLine(t.out), notHeldLine(t.out), pairNotLiveLine(t.out)].filter(Boolean).join(' ');
  const problems = leftOut ? [leftOut] : [];
  let waiting = false;
  // Item 7 of the 2026-09-27 release audit: a coin dropped only because the pre-send existing-order check itself
  // failed (even after readExisting's own retry) used to leave no trace beyond the summary line printed once;
  // recorded here so it survives on period_done, the durable record of what this period actually did.
  const checkFailed = [];
  // Review finding (buy.mjs:503, later): the coins left unsent because an earlier one's order is still waiting
  // were named only in this run's own printed summary, never recorded on period_done, so status could not explain
  // afterward why the period bought nothing for them (the same class manage.mjs:97's checkFailed fix already
  // closed).
  let notSent = [];
  for (const [i, s] of t.shares.entries()) {
    // A 'wait' is a money move whose outcome is unknown: the coins after it are not sent this period.
    if (waiting) {
      notSent = t.shares.slice(i).map((x) => `${x.ccy}-USDT`);
      problems.push(`Not sent, because an earlier order's result is not known yet: ${notSent.join(', ')}.`);
      break;
    }
    const instId = `${s.ccy}-USDT`;
    const clOrdId = buyClOrdId({ planId: plan.id, period, instId, profile: call.profile, demo: call.demo });
    const send = { planId: plan.id, period, instId, clOrdId, amount: centsStr(s.cents), lossPct: s.lossPct, ...acct(call) };
    const before = await readExisting(ctx, call, instId, clOrdId);
    if (!before.notFound) {
      if (!before.row) {
        problems.push(`${instId}: could not check whether this buy was already sent (${before.error}); not sent.`);
        checkFailed.push({ instId, error: before.error });
        continue;
      }
      ctx.store.appendLedger({ kind: 'buy_sent', ...send, found: true }, ctx.now());
      const found = await settle(ctx, call, plan, send, before, 'found');
      if (found.result === 'halt') return 1;
      // The summary names what actually filled, the notional OKX reports, not the share this run tried to send:
      // the two differ, and status already shows the filled figure.
      if (found.result === 'filled') bought.push(`${s.ccy} ${usd(fillOf(before.row).notional)} USDT`);
      if (found.result === 'rejected') problems.push(`${instId}: the buy did not go through. Nothing spent on it.`);
      if (found.result === 'wait') {
        problems.push(`${instId}: ${found.waitLine}`);
        waiting = true;
      }
      continue;
    }
    ctx.store.appendLedger({ kind: 'buy_sent', ...send }, ctx.now());
    const sent = await sendBuy(ctx, call, placeArgs({ instId, cents: s.cents, clOrdId, code }));
    if (sent.rejected) {
      ctx.store.appendLedger({ kind: 'buy_rejected', planId: plan.id, period, instId, clOrdId, ...acct(call), sCode: sent.rejected.sCode, sMsg: sent.rejected.sMsg }, ctx.now());
      problems.push(rejectedLine(instId, sent.rejected));
      continue;
    }
    const back = await readBack(ctx, call, instId, clOrdId);
    const r = await settle(ctx, call, plan, send, back, sent.accepted ? 'accepted' : 'unknown');
    if (r.result === 'halt') return 1;
    if (r.result === 'filled') bought.push(`${s.ccy} ${usd(fillOf(back.row).notional)} USDT`);
    if (r.result === 'rejected') problems.push(`${instId}: the buy did not go through. Nothing spent on it.`);
    if (r.result === 'wait') {
      problems.push(`${instId}: ${r.waitLine}`);
      waiting = true;
    }
  }
  // A coin below OKX's minimum order size (t.dropped, allocate.mjs's fitMinimums) was, before this, invisible
  // after the plan card: the ledger held only the coin that got its share, so a user on a weighted plan could not
  // see why the coin with the largest loss got nothing. Recorded here, only when non-empty, so status's Recent
  // section (manage.mjs) can name it later, and named in the summary below (droppedLine, cards.mjs) so notify and
  // the mail notice at level all say the same thing. Designed behaviour, never a problem: it does not touch
  // `problems` or the severity `tell()` is called with just below.
  ctx.store.appendLedger({
    kind: 'period_done', planId: plan.id, period, ...acct(call), ...(checkFailed.length ? { problems: checkFailed } : {}), ...(t.dropped.length ? { dropped: t.dropped } : {}), ...(notSent.length ? { notSent } : {}),
  }, ctx.now());
  const dropLine = droppedLine(t.dropped);
  const summary = `AvgKeeper bought ${period}: ${bought.length ? bought.join(', ') : 'nothing'}.${problems.length ? ` ${problems.join(' ')}` : ''}${dropLine ? ` ${dropLine}` : ''}`;
  ctx.out(summary);
  await tell(ctx, call, problems.length ? 'problem' : 'info', summary, about(plan, 'buy', period));
  return 0;
}

// What a read-back of a still-unsettled send would resolve to, with no side effect at all (no ledger write, no
// halt, no notice): 'resolves' once the real run's own settle() would turn it into money spent or a rejection and
// move on to the due period, 'halts' once settle() would instead halt the plan for good, or 'open' while it is
// still genuinely open or unreadable right now, the one case the real run still waits on too. readOrder is a read;
// nothing here writes. It is settle()'s own branch tree, settleVerdict, mapped onto these three words (rule 3, one
// fact one reader): a second copy of that tree here is exactly how the dry run and the real run used to disagree.
async function previewSettle(ctx, call, send) {
  const got = await readOrder(ctx, call, { instId: send.instId, clOrdId: send.clOrdId });
  const age = ctx.now() - Date.parse(send.ts);
  const v = settleVerdict(got, 'later', age);
  if (v.decision === 'halt') return 'halts';
  if (v.decision === 'wait') return 'open';
  return 'resolves';
}

// Review finding (buy.mjs:442, blocker): the dry run used to show a split with none of the gates the real run
// checks first (halted, an unsettled send, not due, free USDT below the budget), so it could promise a buy that
// would in fact be skipped, or already was. It now checks the same gates, in the same order, using the same
// readers as buyVerb/locked/buyPeriod (rule 3, one fact one reader), and prints the verdict the real run would
// reach. It never takes the buy lock and never writes to the ledger: it is still a read only, as SKILL.md promises.
async function dryRun(ctx, call, plan) {
  // Review finding (buy.mjs:442, later): the real run (buyVerb) returns at "The plan is halted" before it ever
  // calls preflight, so a halted plan whose own preflight would be unhappy (no AI Builder Code without the
  // owner-test flag, a key permission) must say it is halted first, never a REFUSED line the real run never makes.
  if (plan && plan.halted) {
    ctx.out(planLine(plan));
    ctx.out(`The plan is halted: ${plan.halted}`);
    ctx.out('Right now it would skip: the plan is halted. Nothing is bought until you make a new plan.');
    ctx.out(DRY_SUMMARY);
    return 0;
  }
  const pre = await preflight(ctx, call);
  if (pre.refusals.length) {
    for (const r of pre.refusals) ctx.out(r.msg);
    return 1;
  }
  if (!plan) {
    await readAccount(ctx, call);
    ctx.out("No plan is running yet; OKX answered this run. buy --smoke tests the schedule's own environment once a plan exists.");
    ctx.out(DRY_SUMMARY);
    return 0;
  }
  ctx.out(planLine(plan));
  // New regression: the dry run never checked the buy lock, the same class of gap as the original blocker. A lock
  // older than LOCK_STALE_MS whose pid is still alive (a pid reused after a reboot, say) makes every real run
  // refuse (takeover false, buyVerb). Read only: staleLockLine's readOnly form never takes or moves the lock.
  const staleLock = staleLockLine(ctx.store, call, { readOnly: true });
  if (staleLock) {
    ctx.out(`Right now it would not buy: ${staleLock}`);
    ctx.out(DRY_SUMMARY);
    return 0;
  }
  const tz = timeZoneWarning(plan, ctx.timeZone);
  if (tz) ctx.out(tz);
  const ledger = ctx.store.readLedger();
  const waiting = unsettledSends(ledger, plan.id);
  // Moved up from below the waiting check (review findings, buy.mjs:595, should/later): the real run reads every
  // unsettled send back before it ever asks whether today's period is due (locked() -> resolveOpen always runs
  // first), and when the period is not due it skips nothing at all, it just returns. "Right now it would skip" is
  // only true once a period is actually due; before this, the dry run said it whether or not one was.
  const due = dueNow(ctx.now(), plan, ledger);
  if (waiting.length) {
    // previewSettle reads each one back (a read, never a write) the same way the real run's own resolveOpen would:
    // the real run only ever waits on a send still genuinely open or unreadable right now, so the dry run must
    // read before it says "would skip", not assume every unsettled send still blocks the period (rule 2).
    let halts = false;
    const stillOpen = [];
    for (const s of waiting) {
      const verdict = await previewSettle(ctx, call, s);
      if (verdict === 'halts') { halts = true; break; }
      if (verdict === 'open') stillOpen.push(s);
    }
    if (halts) {
      ctx.out("Right now it would halt: an earlier order's result cannot be read as finished. The next run halts the plan until you make a new one.");
      ctx.out(DRY_SUMMARY);
      return 0;
    }
    if (stillOpen.length) {
      const openLine = `an earlier order's result is not known yet (${stillOpen.map((s) => s.clOrdId).join(', ')}); the next run reads it again.`;
      ctx.out(due.due ? `Right now it would skip: ${openLine}` : `Not due now: ${due.why}. ${openLine}`);
      ctx.out(DRY_SUMMARY);
      return 0;
    }
    // Every waiting send would resolve on the next real run: fall through to the ordinary due/budget verdict below,
    // the same as a real run that reads them all back and then goes on to check whether today's period is due.
  }
  const t = await todaySplit(ctx, call, plan);
  // noBuyReason (cards.mjs) is the one reader buyPeriod uses too, in the same order (review finding, buy.mjs:442,
  // index 10(b)): before this, the dry run checked only the budget, so a day with both no coin in loss and free
  // USDT below budget disagreed with the real run about which reason to name. Finding 10(a): the not-due branch
  // never checked the budget at all, so it could still promise a split the next real run would in fact skip.
  const no = noBuyReason(plan, t);
  if (!due.due) {
    // Review finding (buy.mjs:442, later): named as today's own figures, since a plan due later than today reads a
    // different balance and different prices by then; this is only ever a preview from what OKX answers right now.
    if (no) {
      ctx.out(`Not due now: ${due.why}. With today's balance and prices, at the next buy time it would skip: ${no.reason}`);
    } else {
      ctx.out(`Not due now: ${due.why}. With today's balance and prices, at the next buy time it would split:`);
      for (const line of splitLines(t, plan.only)) ctx.out(line);
    }
  } else if (no) {
    ctx.out(`Right now it would skip: ${no.reason}`);
  } else {
    ctx.out('If it ran now:');
    for (const line of splitLines(t, plan.only)) ctx.out(line);
  }
  ctx.out(DRY_SUMMARY);
  return 0;
}
