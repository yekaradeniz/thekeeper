// avgkeeper/scripts/planview.mjs
// Readers over the ledger. One reader per fact (ProjectBuilder CLAUDE.md rule 3).
import { isoMinute } from './units.mjs';
import { displayHomePath } from './store.mjs';

export const modeOf = (call) => (call.demo ? 'demo' : 'live');
export const sameAccount = (e, call) => e.profile === (call.profile || null) && e.env === modeOf(call);

// The plan running on this profile and mode: the last plan_active line, unless a plan_stopped for it came later.
// A plan_halted for it keeps it on record with halted set to the reason.
export function activePlan(ledger, call) {
  let plan = null;
  for (const e of ledger) {
    if (!sameAccount(e, call)) continue;
    if (e.kind === 'plan_active') plan = { ...e, halted: null, haltedPeriod: null };
    else if (plan && e.planId === plan.id && e.kind === 'plan_stopped') plan = null;
    // haltedPeriod: the period halt() named on this line (buy.mjs), or null for a halt outside any single period
    // (an auth failure before due was ever read). Read by closeStalePeriods (buy.mjs) so a halted plan's own halt
    // period, which halt() never writes period_done for by design, is never treated as one more stale period to
    // close: the halt already sent its own notice with the same fill details (review finding, buy.mjs:365 area).
    else if (plan && e.planId === plan.id && e.kind === 'plan_halted') plan = { ...plan, halted: e.reason, haltedPeriod: e.period ?? null };
  }
  return plan;
}

// Whether a plan was ever confirmed on this account, whatever became of it since (stopped, halted, replaced).
// Unlike activePlan, a plan_stopped line never clears this: doctor uses it so a stopped plan still gets the
// schedule-removal lines instead of a bare "No plan yet" that reads as if none had ever run (item 3 of the
// 2026-09-27 release audit).
export function everHadPlan(ledger, call) {
  return ledger.some((e) => sameAccount(e, call) && e.kind === 'plan_active');
}

const SETTLES = new Set(['buy_filled', 'buy_rejected', 'buy_unknown']);
// The client ids of every send whose outcome is already recorded. One reader for unsettledSends and
// unsettledOnAccount, so the two never drift apart on what counts as settled.
const settledClOrdIds = (ledger) => new Set(ledger.filter((e) => SETTLES.has(e.kind)).map((e) => e.clOrdId));

// buy_sent lines of a plan whose outcome is not recorded yet.
export function unsettledSends(ledger, planId) {
  const settled = settledClOrdIds(ledger);
  return ledger.filter((e) => e.kind === 'buy_sent' && e.planId === planId && !settled.has(e.clOrdId));
}

// Every send on this profile and mode, of any plan, whose outcome is not recorded yet. Plan confirm refuses while
// one exists, whichever plan sent it.
export function unsettledOnAccount(ledger, call) {
  const settled = settledClOrdIds(ledger);
  return ledger.filter((e) => e.kind === 'buy_sent' && sameAccount(e, call) && !settled.has(e.clOrdId));
}

// The instant this incarnation of a plan's life began: its own plan_active line's own ts (activePlan already
// returns it on every plan it hands back, one ledger line per call site, rule 3). A plan id is a hash of the
// plan's own settings alone (plan.mjs's planId), so a user who stops or halts a plan and remakes it with identical
// settings gets the same id back. Every reader that answers "what has THIS plan done" by planId alone would then
// read the earlier, ended life's own lines as this new one's own. Scoped from here (stalePeriods below, and
// period.mjs's lastRun), one instant for both, so neither can drift from the other (rule 3, one fact one reader).
// NaN when plan carries no readable ts, which excludes nothing: every caller already guards with Number.isFinite.
export const planLifeStart = (plan) => Date.parse(plan.ts);

// This plan's own periods that have at least one buy_sent, every one of them already settled, and still no
// period_done: a run that sent and settled its very last order, then died before ever writing period_done, leaves
// no unsettled send at all (unsettledSends above finds nothing), so nothing points resolveOpen at it. Review
// findings (buy.mjs:231, buy.mjs:256).
//
// plan: the running plan itself (activePlan's own return), not just its id. New regression: a plan id is a hash of
// the plan's own settings alone (plan.mjs's planId), so a plan the user remakes with the same settings after a
// halt gets the halted plan's own id, and halt() never writes period_done by design. Reading by planId alone then
// read the OLD incarnation's own buy_sent (settled unknown by the halt) as THIS new incarnation's own stale
// period, closing a period the new plan never touched and telling the user a run happened that did not. Scoped to
// this plan's own life, from its own plan_active line's ts (planLifeStart above), so a remade, stopped-and-restarted
// or switched-back-to plan always starts clean.
export function stalePeriods(ledger, plan) {
  const planId = plan.id;
  const since = planLifeStart(plan);
  const settled = settledClOrdIds(ledger);
  const done = new Set(ledger.filter((e) => e.kind === 'period_done' && e.planId === planId).map((e) => e.period));
  const byPeriod = new Map();
  for (const e of ledger) {
    if (e.kind !== 'buy_sent' || e.planId !== planId) continue;
    if (Number.isFinite(since) && Date.parse(e.ts) < since) continue;
    if (!byPeriod.has(e.period)) byPeriod.set(e.period, []);
    byPeriod.get(e.period).push(e.clOrdId);
  }
  const stale = [];
  for (const [period, clOrdIds] of byPeriod) {
    if (!done.has(period) && clOrdIds.every((id) => settled.has(id))) stale.push(period);
  }
  return stale;
}

// Writes the actual buy_unknown lines for `sends`, each under its own planId (never one imposed on all of them:
// markUnsettledOnAccountUnknown below can be clearing more than one plan's own leftovers at once). Shared so the
// two exported markers below never word this fact two ways (rule 3, one fact one reader).
function markUnknown(store, sends, call, error, now) {
  for (const s of sends) {
    store.appendLedger({
      kind: 'buy_unknown', planId: s.planId, period: s.period, instId: s.instId, clOrdId: s.clOrdId, amount: s.amount, profile: call.profile, env: modeOf(call), error,
    }, now);
  }
  return sends;
}

// The one writer of "this send's outcome is unknown" for a plan that ends before its sends were read back (a halt
// or a stop): each unsettled send of the plan gets a buy_unknown with this error. Returns the sends it marked. An
// unreadable ledger marks nothing, so the caller can still write the halt or stop itself.
export function markSendsUnknown(store, call, planId, error, now) {
  let open = [];
  try {
    open = unsettledSends(store.readLedger(), planId);
  } catch {
    open = [];
  }
  return markUnknown(store, open, call, error, now);
}

// Every unsettled send on this account, whichever plan sent it, marked unknown the same way. Review finding
// (manage.mjs:199 area, should): a crash between an earlier stop's own plan_stopped and its own markSendsUnknown
// (or a still-older plan's send nothing ever revisited) can leave a send unsettled with no plan running at all:
// buy sees no plan and refuses to buy it, and confirm refuses on it forever, since neither the ended plan's own
// schedule nor a new one's ever reads it back. stop's own no-plan branch is the one surface left to clear it.
export function markUnsettledOnAccountUnknown(store, call, error, now) {
  let open = [];
  try {
    open = unsettledOnAccount(store.readLedger(), call);
  } catch {
    open = [];
  }
  return markUnknown(store, open, call, error, now);
}

// The buy lock: one per profile and mode, taken by buy, plan confirm and stop.
export const buyLockName = (call) => `buy-${call.profile}-${modeOf(call)}`;
// What a held lock proves, and no more: some process holds the file. It does not say that process is buying.
export const LOCK_HELD_LINE = 'Another AvgKeeper run holds the buy lock for this profile.';

// Review finding (planview.mjs:73): the non-read-only form always said "AvgKeeper could not buy", whatever action
// actually hit the lock. stop reads that as the plan still buying nothing, when in fact it is still on and buys
// again once the lock is gone; confirm reads it as a buy failing, when no plan has started yet to buy anything.
const STALE_LOCK_ACTIONS = {
  buy: 'AvgKeeper could not buy',
  stop: 'AvgKeeper could not stop the plan; it is still on and buys again once the lock is gone',
  confirm: 'AvgKeeper could not start the new plan',
};

// The sentence for a buy lock older than LOCK_STALE_MS, or null. One reader for buy, stop, plan confirm, status
// and doctor (ProjectBuilder CLAUDE.md rules 3 and 4). status and doctor only ever read the lock, they never try
// to buy, so { readOnly: true } gives them a form that does not claim any action was attempted. action names what
// the caller was actually trying to do (one of STALE_LOCK_ACTIONS above; 'buy' when omitted, buy's own default).
export function staleLockLine(store, call, { readOnly = false, action = 'buy' } = {}) {
  const age = store.staleLock(buyLockName(call));
  if (age === null) return null;
  // Review findings (buy.mjs:568, period.mjs:315): a stale lock file's age alone is not what the real gate acts
  // on. lock(name, {takeover:false}) (every real caller of this lock) takes over a dead pid, or empty or garbage
  // content, at any age; only a live or EPERM pid keeps it held. lockDecision applies that same rule with no side
  // effect, so a read-only caller (a dry run, status, doctor) never names this lock as a cause the real run would
  // not in fact refuse over. The non-readOnly call below never reaches this check: it only runs once store.lock
  // has already refused for real, so its own "held" is not a guess.
  if (readOnly && store.lockDecision(buyLockName(call)) !== 'held') return null;
  const when = isoMinute(Date.now() - age);
  // Review finding (planview.mjs:77): a hard-coded ~/.avgkeeper is the wrong file whenever AVGKEEPER_HOME points
  // elsewhere; displayHomePath names the store this run actually used.
  const lockPath = displayHomePath(store.home, `${buyLockName(call)}.lock`);
  if (readOnly) {
    return `The buy lock from ${when} is still held (another AvgKeeper run, or one that crashed). If no AvgKeeper run is working, delete ${lockPath}.`;
  }
  const said = STALE_LOCK_ACTIONS[action] || STALE_LOCK_ACTIONS.buy;
  return `${said}: a lock from ${when} (another AvgKeeper run, or one that crashed) is still held. If no AvgKeeper run is working, delete ${lockPath}.`;
}

// The HALTED sentence for a halted plan, or null. One reader for status and doctor.
export function haltedLine(plan) {
  if (!plan || !plan.halted) return null;
  return `HALTED: ${plan.halted} Nothing is bought until you make a new plan.`;
}

// The Waiting sentence for a plan's unsettled sends, or null. One reader for status and doctor. plan: the running
// plan itself, not just its id. New regression (finding 16 remaining): a halted plan never reads its own open
// sends back again (buy.mjs's halt() ends before any lock is taken again), but this always promised "the next
// scheduled run reads it back", the opposite of what plan.mjs already tells the user at confirm time. A halted
// plan now names stop instead (rule 4: a fact one surface knows, every surface knows).
export function waitingLine(ledger, plan) {
  const open = unsettledSends(ledger, plan.id);
  if (!open.length) return null;
  const n = open.length === 1 ? '1 order' : `${open.length} orders`;
  const pron = open.length === 1 ? 'it' : 'them';
  if (plan.halted) {
    return `Waiting: ${n} whose result${open.length === 1 ? ' is' : 's are'} not recorded yet. The plan is halted and never reads ${pron} back on its own. Run stop to clear ${pron}, then make a new plan.`;
  }
  return open.length === 1
    ? 'Waiting: 1 order whose result is not recorded yet; the next scheduled run reads it back.'
    : `Waiting: ${open.length} orders whose results are not recorded yet; the next scheduled run reads them back.`;
}

// The schedule fires at the machine's local time and the plan decides due by the time zone it was made in; when
// the two differ, the buy can fire at a time the plan does not expect. One reader for buy, status and doctor.
export function timeZoneWarning(plan, timeZone) {
  if (!plan || !timeZone || plan.timeZone === timeZone) return null;
  return `WARNING: this plan was made in ${plan.timeZone}, but this Mac is now on ${timeZone}. The schedule fires at machine time, so make a new plan and run doctor again.`;
}

// A fact one surface knows, every surface knows (ProjectBuilder CLAUDE.md rule 4): readLedger tolerates one
// unreadable line and names it on the array it returns; every verb that reads the ledger shows this same line.
// Review finding (planview.mjs:107): the old wording ("Fix or remove that line; a second bad line stops every
// AvgKeeper run") implied runs otherwise go on. In fact buy.mjs already refuses every buy while the ledger is
// torn, whether or not a second line ever breaks: the sentence now states that fact instead.
// home: the store's own home (ctx.store.home), so the file named is the one this run actually used, never a
// hard-coded ~/.avgkeeper when AVGKEEPER_HOME points elsewhere (review finding, planview.mjs:77).
// Review finding (planview.mjs:185, should): the skipped line can be the plan_stopped or plan_halted that ended a
// plan; removing it, as the old wording invited on equal footing with fixing it, starts that plan again with no
// word to the user (buy.mjs:69 already knew this about read-past-it, but told no one). Named here, with the one
// fix that actually closes the risk: run stop again right after removing the line, so a plan that comes back this
// way is stopped for real.
export function tornWarning(ledger, home) {
  if (!ledger.torn) return null;
  // Review finding (manage.mjs:201 area / plan.mjs:146, later): "run stop again" presumes stop already ran; the
  // skipped line can just as well be a plan_halted, which stop never wrote and never touched.
  return `WARNING: line ${ledger.tornLine} of ${displayHomePath(home, 'ledger.jsonl')} could not be read and was skipped. Every scheduled buy refuses until that line is fixed or removed; a second bad line stops every AvgKeeper command. If that line ended a plan (plan_stopped or plan_halted), removing it can start that plan again: run stop after you remove it.`;
}

// Review finding (manage.mjs:199 area, later): stop already refuses outright rather than claim no plan is running
// while a ledger line cannot be read (its own no-plan branch, manage.mjs), since the skipped line could have been
// the very plan_active this profile never showed as running. Status, holdings and doctor still stated it as a
// plain fact and invited a plan card, which the card would then say AVGPLAN is certain to refuse (rule 4, a fact
// one surface knows, every surface knows). This is the one caveat all three append to their own "no plan" line.
export function noPlanTornCaveat(ledger) {
  return ledger.torn ? ' AvgKeeper cannot be sure: a ledger line could not be read (see the WARNING above).' : '';
}

// The newest plan_card with this id on this account that is younger than ttl.
export function freshCard(ledger, call, id, now, ttl) {
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const e = ledger[i];
    if (e.kind !== 'plan_card' || e.planId !== id || !sameAccount(e, call)) continue;
    const age = now - Date.parse(e.ts);
    if (age >= 0 && age < ttl) return e;
  }
  return null;
}
