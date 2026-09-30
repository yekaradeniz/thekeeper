// avgkeeper/scripts/manage.mjs
// holdings, status, stop and notify: the verbs that read, end a plan, or set the notify level. None sends an order.
import { readAccount, liveUsdtPairs } from './today.mjs';
import { displayHomePath } from './store.mjs';
import { candidates, usdtAvailable, readDust } from './holdings.mjs';
import {
  activePlan, modeOf, sameAccount, tornWarning, noPlanTornCaveat, markSendsUnknown, markUnsettledOnAccountUnknown,
  buyLockName, LOCK_HELD_LINE, staleLockLine, timeZoneWarning, haltedLine, waitingLine, everHadPlan,
} from './planview.mjs';
import { lastRunLine, missingPeriodsWarning } from './period.mjs';
import { planLine, coinsLine, droppedLine } from './cards.mjs';
import {
  readConfigSafe, levelOf, NOTIFY_LEVELS, LEVEL_WORDS,
} from './notify.mjs';
import { mailStatus, mailReachLine } from './mail.mjs';
import { centsStr } from './decimal.mjs';
import { usd, pct, sigPrice } from './units.mjs';
import { orderName } from './orders.mjs';
import { rejectedLine, closeStalePeriods } from './buy.mjs';
import { clause } from './runner.mjs';
import { commandText } from './cmdtext.mjs';
import { removeScheduleLines, removeSchedule } from './schedule.mjs';
import { logStatusLines } from './runlog.mjs';
import {
  resolveSite, gSite, isNoKeySavedFailure, noKeySavedLine, readKeyConfig, keyPermRefusals,
} from './guards.mjs';

const STATUS_ROWS = 10;

export async function holdingsVerb(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const dust = readDust(o.dust);
  if (dust.error) {
    ctx.out(`REFUSED: ${dust.error}`);
    return 1;
  }
  // Item 5 of the 2026-09-27 release audit: holdings is the one verb that read the account without ever checking
  // the profile exists first (every other verb goes through preflight, which does this same check before its own
  // account read). A profile absent from the okx config used to surface as an OKX auth failure ("OKX did not
  // accept API key X"), which reads as OKX rejecting a real key rather than the key never having been saved at
  // all. resolveSite and gSite are the same reader preflight uses (rule 3, one fact one reader).
  const shown = await ctx.okx.json(['config', 'show']);
  const site = resolveSite((shown.data || {}).profiles, call.profile);
  const siteRefusal = gSite(call.profile, site);
  if (siteRefusal) {
    ctx.out(siteRefusal.msg);
    return 1;
  }
  // A fact one surface knows, every surface knows (ProjectBuilder CLAUDE.md rule 4): status and doctor already
  // show a torn ledger line; holdings reads the ledger too, for the running plan, so it shows the same warning.
  const ledger = ctx.store.readLedger();
  const warning = tornWarning(ledger, ctx.store.home);
  if (warning) ctx.out(warning);
  let rows;
  try {
    // Findings 7 and 13 of the 2026-09-27 release-readiness review: the key guide sends a new user here to check
    // the connection, and says a wrong key permission is named instead of a coin list. The same reader and checks
    // preflight uses (rule 3), before any balance read.
    const key = await readKeyConfig(ctx, call);
    const permRefusals = keyPermRefusals(call.profile, key.perm);
    if (permRefusals.length) {
      for (const r of permRefusals) ctx.out(r.msg);
      return 1;
    }
    rows = await readAccount(ctx, call);
  } catch (e) {
    // The profile IS in the okx config (the check above passed), but the okx CLI has no key it can use for it: a
    // different failure from an absent profile, worded in the user's own words instead of the generic "OKX did not
    // accept API key" line, which reads as OKX rejecting a key that was in fact never there to read.
    if (isNoKeySavedFailure(e)) {
      ctx.out(`REFUSED: ${noKeySavedLine(call.profile)}`);
      return 1;
    }
    throw e;
  }
  const pairs = await liveUsdtPairs(ctx, call);
  const runningPlan = activePlan(ledger, call);
  const plan = runningPlan || { only: null, exclude: null, dust: centsStr(dust.cents) };
  const { inPlan, out } = candidates(rows, plan, pairs);
  ctx.out(`Your coins on profile ${call.profile} (${modeOf(call)}). Profit and loss is OKX's own figure against your average buy price.`);
  // Review finding (manage.mjs:78, later): --dust was accepted and then silently ignored while a plan runs, since
  // the running plan's own dust decides "out: worth under ..." above. Named here so the user learns which
  // threshold actually decided, instead of assuming the flag they passed did.
  // Review finding (manage.mjs:84, later): an only-these plan applies no dust threshold at all (reasonOut skips
  // that check once `only` is set), so naming one it never uses claimed a fact that is not true for it; and the
  // line called a halted plan "running", the mislabel manage.mjs:81's own fix already closed for every other line
  // on this screen.
  if (o.dust !== undefined && runningPlan) {
    const which = runningPlan.halted ? 'halted' : 'running';
    if (runningPlan.only) ctx.out(`The ${which} plan only ever buys ${runningPlan.only.join(', ')} (--only), so --dust has no effect on it.`);
    else ctx.out(`Using the ${which} plan's dust threshold ${runningPlan.dust} USDT; --dust applies only with no plan.`);
  }
  // Review finding (manage.mjs:81, rule 4): a halted plan buys nothing, but holdings called its coins "in the
  // plan" the same as a healthy one and never mentioned the halt at all. haltedLine is the one reader status and
  // doctor already use for this fact.
  const halted = runningPlan && haltedLine(runningPlan);
  if (halted) ctx.out(halted);
  for (const c of [...inPlan, ...out].sort((a, b) => (b.eqUsd || 0) - (a.eqUsd || 0))) {
    // Item 6 of the 2026-09-27 release audit: with no plan actually running, "in the plan" claimed a plan that
    // does not exist; this coin would only be bought if the user made one with these default settings.
    const state = c.why ? `out: ${c.why}` : (halted ? 'in the halted plan (not bought)' : runningPlan ? 'in the plan' : 'a plan would buy it');
    // Review finding (manage.mjs:82): spec section 3 promises amount and OKX's own average cost alongside value and
    // profit or loss; both were missing. The raw string is shown at full precision (sigPrice), '?' for a field OKX
    // did not send (never invented, rule 1).
    const amount = Number.isFinite(c.amount) ? sigPrice(c.amountRaw) : '?';
    const avgCost = Number.isFinite(c.avgPx) ? sigPrice(c.avgPxRaw) : '?';
    ctx.out(`  ${c.ccy.padEnd(6)} ${usd(c.eqUsd).padStart(10)} USDT  ${pct(c.uplRatio).padStart(7)}%  ${state}  (amount ${amount}, avg cost ${avgCost} USDT)`);
  }
  ctx.out(`Free USDT: ${usd(usdtAvailable(rows))}.`);
  // Review finding (manage.mjs:199 area, later): a torn line can be the very plan_active this profile never
  // showed as running; stated as plain fact, this invited a plan card that AVGPLAN would then be certain to
  // refuse (rule 4, a fact one surface knows, every surface knows).
  if (!runningPlan) ctx.out(`No plan is running yet on profile ${call.profile} (${modeOf(call)}); ask your agent for a plan card to start one.${noPlanTornCaveat(ledger)}`);
  return 0;
}

function historyLine(e) {
  if (e.kind === 'buy_filled') return `  ${e.period} ${e.instId} ${usd(e.notional)} USDT filled at ${sigPrice(e.avgPx)}`;
  if (e.kind === 'buy_rejected') {
    // Review finding (manage.mjs:91, index 23): a row with a real sCode is OKX's own rejection of the send itself
    // (sendBuy, buy.mjs), the same fact the buy summary already turns into one plain sentence with rejectedLine,
    // in place of OKX's own message, up to 300 characters for the disclaimer code (rule 3, one fact one reader). A
    // row settle() wrote itself (not found, or finished with nothing filled) carries no sCode and keeps its own
    // plain sentence, unchanged.
    return e.sCode ? `  ${e.period} ${rejectedLine(e.instId, e)}` : `  ${e.period} ${e.instId} not bought: ${e.sMsg || e.sCode}`;
  }
  if (e.kind === 'buy_unknown') return `  ${orderName(e.instId, e.amount, e.period, e.clOrdId)} result unknown: ${clause(e.error)}. Check it in the OKX app.`;
  if (e.kind === 'period_skipped') return `  ${e.period} skipped: ${e.reason}`;
  if (e.kind === 'period_done') {
    // A coin dropped for OKX's minimum order size (period_done's own `dropped`, buy.mjs) is invisible in Recent
    // without this: the row above already shows the buys of this same period; this names what that period's own
    // ledger line held back from them. droppedLine (cards.mjs) is the one builder every surface uses (rule 4).
    // Review finding (manage.mjs:97): a coin held back only because the pre-send existing-order check itself
    // failed (period_done's own `problems`, buy.mjs's checkFailed) was recorded but never shown anywhere; both
    // reasons a coin can be missing from this period's own buys are named on the same line now.
    // Review finding (buy.mjs:503, later): a coin left unsent because an earlier one's order was still waiting is
    // named the same way this run's own summary already named it, the one reader for this fact (rule 3).
    // Review finding (manage.mjs, later): the parts below used to join with a bare space. "problems" carried no
    // closing period, so it ran straight into whatever followed with no separation, and a part after droppedLine's
    // own trailing period started lowercase, as if still mid-sentence. Each is now its own full sentence.
    const parts = [];
    if (e.dropped && e.dropped.length) parts.push(droppedLine(e.dropped));
    if (e.problems && e.problems.length) parts.push(`Not sent: ${e.problems.map((p) => `${p.instId} (could not check whether it was already sent)`).join(', ')}.`);
    // "was not known then", not "is not known yet": a history row is read well after the fact, possibly after the
    // order in question resolved one way or another.
    if (e.notSent && e.notSent.length) parts.push(`Not sent, because an earlier order's result was not known then: ${e.notSent.join(', ')}.`);
    if (parts.length) return `  ${e.period} ${parts.join(' ')}`;
  }
  return null;
}

export async function statusVerb(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const ledger = ctx.store.readLedger();
  // A fact one surface knows, every surface knows (ProjectBuilder CLAUDE.md rule 4): readLedger tolerates one
  // unreadable line and names it on the array it returns; status shows the same warning doctor would show.
  const warning = tornWarning(ledger, ctx.store.home);
  if (warning) ctx.out(warning);
  const stale = staleLockLine(ctx.store, call, { readOnly: true });
  if (stale) ctx.out(stale);
  // Review finding (notify.mjs:59, should): doctor already prints this line (as a FAIL); status read config
  // through mailStatus, which discards readConfigSafe's own `line`, so a broken config.json showed only a bare
  // "Mail: off." here with no reason, even when the user had set mail to all (rule 4, a fact one surface knows,
  // every surface knows).
  const { line: configLine } = readConfigSafe(ctx.store);
  if (configLine) ctx.out(`WARNING: ${configLine}`);
  const mail = mailStatus(ctx.store, ledger, call);
  ctx.out(mail.line);
  if (mail.pending) ctx.out(`Mail waiting to be sent: ${mail.pending}. See them: ${commandText(`mail --pending --profile ${call.profile}${call.demo ? ' --demo' : ''}`)}.`);
  const plan = activePlan(ledger, call);
  if (!plan) {
    // Review finding (manage.mjs:199 area, later): the same caveat holdings and doctor now carry, for the same
    // reason: a torn line could have been the very plan_active this profile never showed as running.
    ctx.out(`No plan is running on profile ${call.profile} (${modeOf(call)}). Ask your agent for a plan card to start one.${noPlanTornCaveat(ledger)}`);
  } else {
    // Review finding (manage.mjs:81, rule 4): a halted plan buys nothing, and status already prints its own
    // HALTED line further down; heading it "Running:" the same as a healthy plan said the opposite first.
    // Review finding (planview.mjs:185, should): a torn line above can be the very plan_stopped or plan_halted
    // that ended this plan; a bare "Running:" then claims a certainty the code does not have.
    const head = plan.halted ? 'Halted' : (ledger.torn ? 'Running (unconfirmed while a ledger line is torn, see the WARNING above)' : 'Running');
    ctx.out(`${head}: ${planLine(plan)} Started ${plan.activeFrom}.`);
    ctx.out(coinsLine(plan));
    ctx.out(lastRunLine(ledger, plan));
    const missing = missingPeriodsWarning(ledger, plan, ctx.now(), Boolean(stale));
    if (missing) ctx.out(missing);
    for (const l of logStatusLines(ctx.store.home, call, plan.timeZone)) ctx.out(l);
    const tz = timeZoneWarning(plan, ctx.timeZone);
    if (tz) ctx.out(tz);
    const halted = haltedLine(plan);
    if (halted) ctx.out(halted);
    const waiting = waitingLine(ledger, plan);
    if (waiting) ctx.out(waiting);
  }
  const history = ledger.filter((e) => sameAccount(e, call)).map(historyLine).filter(Boolean).slice(-STATUS_ROWS);
  ctx.out(history.length ? 'Recent:' : 'Nothing bought or skipped yet.');
  for (const line of history) ctx.out(line);
  return 0;
}

// stop takes the buy lock, as buy and plan confirm do: a buy mid-send must not have its plan end underneath it. Each
// send of the plan still waiting for a result is recorded unknown and named first, because nothing reads a stopped
// plan's orders back again.
export async function stopVerb(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const release = ctx.store.lock(buyLockName(call), { takeover: false });
  if (!release) {
    ctx.out(`REFUSED: ${staleLockLine(ctx.store, call, { action: 'stop' }) || `${LOCK_HELD_LINE} Try again in a few minutes.`}`);
    return 1;
  }
  try {
    return await stopLocked(ctx, call);
  } finally {
    release();
  }
}

async function stopLocked(ctx, call) {
  const ledger = ctx.store.readLedger();
  // Review finding (planview.mjs:185, should): stop used to print no torn warning at all, unlike status, doctor,
  // holdings and plan (rule 4, a fact one surface knows, every surface knows).
  const warning = tornWarning(ledger, ctx.store.home);
  if (warning) ctx.out(warning);
  const plan = activePlan(ledger, call);
  // Item 3 of the 2026-09-27 release audit: the same commands doctor prints, from schedule.mjs's one writer
  // (finding 10 of the release-readiness review), named here directly rather than by pointing back at doctor.
  // Unloading a launchd job alone leaves its plist file, which launchd loads again at the next login; removing the
  // file too is what actually ends the schedule. stop itself is what ends the plan.
  const removal = removeScheduleLines(call, ctx.platform, ctx.realHome);
  if (!plan) {
    // Review finding (planview.mjs:185, should): the torn line itself could be the plan_active this profile never
    // showed, so "No plan was running ... Nothing changed." would claim a certainty the code does not have.
    if (ledger.torn) {
      ctx.out('REFUSED: AvgKeeper cannot tell whether a plan is running while a ledger line cannot be read (see the WARNING above). Fix or remove that line, then ask for stop again.');
      return 1;
    }
    // Review finding (manage.mjs:199 area, should): a crash between an earlier stop's own plan_stopped and its own
    // markSendsUnknown (or a still older plan nothing ever revisited) can leave a send unsettled with no plan
    // running at all: buy refuses to buy it and confirm refuses on it forever, since neither the ended plan's own
    // schedule nor a new one ever reads it back. Cleared here too, the one surface left that can.
    const open = markUnsettledOnAccountUnknown(ctx.store, call, 'no plan is running to read this order back; an earlier stop or a crash left it unsettled', ctx.now());
    if (open.length) {
      const n = open.length === 1 ? '1 order' : `${open.length} orders`;
      const was = open.length === 1 ? 'was' : 'were';
      ctx.out(`No plan was running on profile ${call.profile} (${modeOf(call)}), but ${n} from an earlier plan ${was} not read back yet and ${open.length === 1 ? 'is' : 'are'} now recorded as unknown. Check order(s) in the OKX app: ${open.map((s) => orderName(s.instId, s.amount, s.period, s.clOrdId)).join(', ')}.`);
    }
    // Finding 12 of the release-readiness review: a user who comes back weeks later to take the schedule out gets
    // the commands from a second stop too, from local facts only. The removal runs before the sentence below is
    // printed, because "Nothing changed." is true only when the removal found nothing to remove: a stop that then
    // prints "Schedule removed." must not have said nothing changed one line earlier.
    const gone = everHadPlan(ledger, call) ? await scheduleRemoval(ctx, call, removal) : null;
    if (!open.length) {
      ctx.out(`No plan was running on profile ${call.profile} (${modeOf(call)}).${!gone || gone.nothingRemoved ? ' Nothing changed.' : ''}`);
    }
    if (gone) for (const l of gone.lines) ctx.out(l);
    return 0;
  }
  // Review finding (manage.mjs:199, should): plan_stopped is written FIRST, the same order halt() already uses
  // (round 1). A crash or ENOSPC between the two writes must never leave a send marked unknown on a plan the
  // ledger still shows as active: the next scheduled run would then read past the missing plan_stopped and buy
  // the next period over a send it never read back (spec section 5).
  ctx.store.appendLedger({ kind: 'plan_stopped', planId: plan.id, profile: call.profile, env: modeOf(call), reason: 'stopped by you' }, ctx.now());
  const open = markSendsUnknown(ctx.store, call, plan.id, 'the plan was stopped before this order was read back', ctx.now());
  // Review finding (manage.mjs:231, should, paths lens): a run that died partway through a period can leave it
  // stale (a coin filled, no period_done, no notice). This must run only after the two writes above: the common
  // death is mid-send (one coin filled, the next still open with no result read back at all), and such a period
  // reads as stale only once its own open send is marked unknown, never before. Closed here, before the plan
  // itself ends, so money that period already spent still reaches a mail with its details (spec section 9), the
  // same as the next scheduled run of this plan's life would have closed it.
  await closeStalePeriods(ctx, call, plan);
  ctx.out(`Plan ${plan.id} is stopped. Nothing more is bought. Your coins stay where they are.`);
  if (open.length) ctx.out(`The result of ${open.length === 1 ? '1 order' : `${open.length} orders`} was not read back yet and is recorded as unknown. Check order(s) in the OKX app: ${open.map((s) => orderName(s.instId, s.amount, s.period, s.clOrdId)).join(', ')}.`);
  for (const l of (await scheduleRemoval(ctx, call, removal)).lines) ctx.out(l);
  return 0;
}

// AvgKeeper takes its own schedule entry out (schedule.mjs's removeSchedule, the one writer) and answers the lines to
// print, so the caller decides where they go. Only a failure falls back to the manual lines, because then the entry
// may still be installed and firing for nothing. nothingRemoved is true only for a clean "found nothing".
async function scheduleRemoval(ctx, call, removal) {
  const r = await removeSchedule(ctx, call);
  if (r.ok) {
    return {
      nothingRemoved: !r.removed,
      lines: [r.removed ? 'Schedule removed.' : 'No AvgKeeper schedule entry was found for this profile, so there was nothing to remove.'],
    };
  }
  return {
    nothingRemoved: false,
    lines: [`The schedule could not be removed (${r.reason}), so an installed entry may still fire and now buys nothing. To take it out:`, ...removal],
  };
}

export async function notifyVerb(ctx, o) {
  const { config, line } = readConfigSafe(ctx.store);
  if (line) {
    ctx.out(`REFUSED: ${line}`);
    return 1;
  }
  if (o.level !== undefined) {
    if (!NOTIFY_LEVELS.includes(o.level)) {
      ctx.out(`REFUSED: --level reads ${o.level}; use off, problems or all.`);
      return 1;
    }
    ctx.store.writeConfig({ ...config, notifyLevel: o.level });
  }
  const level = o.level || levelOf(config);
  ctx.out(`Notify level: ${level}. ${LEVEL_WORDS[level]}`);
  // Review finding (schedule.mjs:244): "so nothing reaches you" is false whenever mail is on. New regression
  // (schedule.mjs:449): the pointer named a line this screen never prints; mailReachLine states the fact itself.
  if (!config.notify) {
    const reach = mailReachLine(config);
    const also = reach ? ` ${reach}.` : '';
    // Review finding (planview.mjs:77): a hard-coded ~/.avgkeeper names the wrong file whenever AVGKEEPER_HOME
    // points elsewhere.
    ctx.out(`No notify command is set yet, so nothing reaches you this way.${also} Add one yourself as the key notify in ${displayHomePath(ctx.store.home, 'config.json')}: a shell command that receives each message as one line on stdin.`);
  }
  return 0;
}
