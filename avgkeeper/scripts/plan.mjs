// avgkeeper/scripts/plan.mjs
// plan, two steps. Step 1 checks everything, reads today's split, prints the card and writes plan_card; it sends
// nothing. Step 2 (--confirm AVGPLAN) needs a card with the same id from the last 30 minutes and writes
// plan_active. Neither step sends an order: only the user's schedule does.
import crypto from 'node:crypto';
import { toCents, centsStr } from './decimal.mjs';
import {
  parseCadence, parseAt, parseHourlyAt, hhmm, localParts,
} from './period.mjs';
import { readDust } from './holdings.mjs';
import { todaySplit } from './today.mjs';
import {
  preflight, gPlanScheduled, builderDisclosure, keyInactivityWarning, profileNameRefusal,
} from './guards.mjs';
import {
  activePlan, unsettledOnAccount, freshCard, modeOf, buyLockName, LOCK_HELD_LINE, staleLockLine, tornWarning,
} from './planview.mjs';
import {
  planCard, planLine, coinsLine, HOURLY_LINE, restartKind, daysShiftLine,
} from './cards.mjs';
import { readConfigSafe } from './notify.mjs';
import { mailLine } from './mail.mjs';
import { closeStalePeriods } from './buy.mjs';
import { installSchedule, viaPhrase } from './schedule.mjs';

export const CONFIRM_WORD = 'AVGPLAN';

// The refusal confirm would print right now (a torn ledger, a stale buy lock, or an unsettled send on this
// account), in confirm's own words, or null when it would not refuse for any of them. Read by the card too
// (cards.mjs's planCard, its own `refusal` param), so it never invites AVGPLAN when confirm is certain to refuse
// it (review finding, cards.mjs:164, later; rule 3, one fact one reader). ledger and running: the caller's own
// reads, so the card reads exactly the same ledger it was already built from, never a second read of its own.
// store: ctx.store, needed only for the stale-lock check (review finding, plan.mjs:146 area, later: a stale lock
// held by a live pid already makes confirm refuse, the same as a9980e6 already closed for torn and unsettled);
// optional so a caller with no store handy (none exist yet) simply skips that one check.
export function confirmRefusal(ledger, call, running, store) {
  if (ledger.torn) return 'a plan cannot be confirmed while a ledger line cannot be read (see the WARNING above); the buy it starts would refuse the same way. Fix or remove that line first.';
  const stale = store && staleLockLine(store, call, { readOnly: true });
  if (stale) return stale;
  const open = unsettledOnAccount(ledger, call);
  if (!open.length) return null;
  const pron = open.length === 1 ? 'it' : 'them';
  // Review finding (manage.mjs:199 area, should): a plan that has already stopped (or crashed between writing
  // plan_stopped and marking its own sends unknown, manage.mjs's own fix) leaves no `running` plan at all, so the
  // schedule will never come read this send back either; only stop does now (manage.mjs's no-plan branch). Halted
  // is the same shape: a halted plan never reads its own sends back on its own either.
  const clue = !running
    ? `No plan is running to read ${pron} back. Run stop to clear ${pron}.`
    : running.halted
      ? `The plan that sent ${pron} is halted and never reads ${pron} back on its own. Run stop to clear ${pron}, then make a new plan.`
      : 'Ask for status, and try again after the next scheduled run reads it back.';
  return `a buy on this profile has a result that is not recorded yet (order(s) ${open.map((s) => s.clOrdId).join(', ')}). ${clue}`;
}

// 2026-09-28: a phone keyboard capitalizes the first letter, so a user who read the card and typed AVGPLAN got
// Avgplan back. True only when text equals CONFIRM_WORD ignoring letter case, and nothing else: SKILL.md rule 2
// loosens letter case only, so surrounding whitespace still refuses, along with extra words, punctuation, a near
// spelling, a look-alike letter, empty, or a non-string. This never infers the word from agreement, only compares
// against it.
export function isConfirmWord(text) {
  return typeof text === 'string' && text.toUpperCase() === CONFIRM_WORD;
}

export const CARD_TTL_MS = 30 * 60000;
export const AT_DEFAULT = '10:00';
// Section 10: an hourly plan's --at is the minute past the hour, default :05.
export const AT_HOURLY_DEFAULT = ':05';
const COIN = /^[A-Z0-9]{1,15}$/;

export function readPlanFlags(o) {
  const errors = [];
  const budgetCents = o.budget === undefined ? null : toCents(String(o.budget));
  if (o.budget === undefined) errors.push('pass --budget <USDT per buy>, for example --budget 10.');
  else if (budgetCents === null || budgetCents < 100) errors.push(`--budget must be a USDT amount of at least 1 with at most two decimals; it reads ${o.budget}.`);
  const cadence = o.every === undefined ? null : parseCadence(o.every);
  if (o.every === undefined) errors.push('pass --every hour, --every day, --every days:<2-365>, --every week:<mon..sun> or --every month:<1-31>.');
  else if (!cadence) errors.push(`--every reads ${o.every}; use hour, day, days:<2-365>, week:<mon..sun> or month:<1-31>.`);
  // --at reads differently by cadence (section 10): the minute past the hour for an hourly plan, a time of day for
  // every other one. Each wrong shape is refused with a sentence naming the form this cadence actually needs. While
  // --every cannot be read there is no form to name, so --at is judged only once it can; the --every refusal stands.
  const hourly = Boolean(cadence && cadence.kind === 'hour');
  const at = o.at === undefined ? (hourly ? AT_HOURLY_DEFAULT : AT_DEFAULT) : String(o.at);
  if (hourly) {
    if (!Number.isFinite(parseHourlyAt(at))) errors.push(`--at for an hourly plan is the minute past the hour, like ${AT_HOURLY_DEFAULT}; it reads ${o.at}.`);
  } else if (cadence && !Number.isFinite(parseAt(at))) errors.push(`--at must be a time like ${AT_DEFAULT}; it reads ${o.at}.`);
  if (o.method === undefined) errors.push('pass --method equal or --method weighted.');
  else if (!['equal', 'weighted'].includes(o.method)) errors.push(`--method reads ${o.method}; use equal or weighted.`);
  if (o.only !== undefined && o.exclude !== undefined) errors.push('pass --only or --exclude, not both.');
  const list = (v, flag) => {
    if (v === undefined) return null;
    const coins = String(v).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!coins.length || !coins.every((c) => COIN.test(c))) {
      errors.push(`${flag} must be coin symbols separated by commas, like BTC,ETH; it reads ${v}.`);
      return null;
    }
    return [...new Set(coins)].sort();
  };
  const only = list(o.only, '--only');
  const exclude = list(o.exclude, '--exclude');
  const dust = readDust(o.dust);
  if (dust.error) errors.push(dust.error);
  if (errors.length) return { errors };
  return {
    fields: {
      budget: centsStr(budgetCents), cadence: o.every, at, method: o.method, only, exclude, dust: centsStr(dust.cents),
    },
  };
}

export function planId(fields, call, timeZone) {
  const parts = { ...fields, profile: call.profile || null, demo: Boolean(call.demo), timeZone };
  return 'p' + crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

export async function planVerb(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const sched = gPlanScheduled(ctx.env);
  if (sched) {
    ctx.out(sched.msg);
    return 1;
  }
  // Before the card and before confirm, since both come through here: a name the schedule cannot keep apart from
  // another profile's (guards.mjs) never gets a card to read or a plan to start.
  const nameRefusal = profileNameRefusal(o.profile);
  if (nameRefusal) {
    ctx.out(nameRefusal);
    return 1;
  }
  const read = readPlanFlags(o);
  if (read.errors) {
    for (const e of read.errors) ctx.out(`REFUSED: ${e}`);
    return 1;
  }
  const pre = await preflight(ctx, call);
  if (pre.refusals.length) {
    for (const r of pre.refusals) ctx.out(r.msg);
    return 1;
  }
  // Review finding (planview.mjs:107, rule 4): a torn ledger line already refuses every buy; the card and confirm
  // say so too, in the same words holdings, status and doctor already use (rule 3, one fact one reader).
  const ledger0 = ctx.store.readLedger();
  const torn = tornWarning(ledger0, ctx.store.home);
  if (torn) ctx.out(torn);
  const timeZone = ctx.timeZone;
  const id = planId(read.fields, call, timeZone);
  const plan = { id, profile: call.profile, env: modeOf(call), ...read.fields, timeZone };
  const now = ctx.now();
  if (o.confirm === undefined) {
    const t = await todaySplit(ctx, call, plan);
    const running = activePlan(ledger0, call);
    // Review finding (plan.mjs:132, later): status already prints this as a WARNING (notify.mjs:59); the card
    // used to discard it and print a bare "Mail: off." for a user who in fact set mail to all.
    const { config, line: configLine } = readConfigSafe(ctx.store);
    if (configLine) ctx.out(`WARNING: ${configLine}`);
    // Review finding (cards.mjs:164, later): read from this same ledger0, the one the card itself is built from,
    // so the card's own advisory never disagrees with the read it was shown on (it can still go stale by the time
    // the user actually types AVGPLAN, the same as every other fact a 30-minute-old card shows).
    const refusal = confirmRefusal(ledger0, call, running, ctx.store);
    // Review findings (cards.mjs:163, should and later): the card is the consent screen, read before AVGPLAN is
    // ever typed; a same-id restart's own every-N-days re-anchor (daysShiftLine, cards.mjs) is named here too, not
    // only on the receipt after the fact.
    const today = localParts(now, timeZone).date;
    for (const line of planCard(plan, modeOf(call), t, running, config, pre.ownerTest, pre.ip, refusal, today, ctx.platform || process.platform)) ctx.out(line);
    ctx.store.appendLedger({ kind: 'plan_card', planId: id, profile: call.profile, env: modeOf(call), ...read.fields, timeZone }, now);
    return 0;
  }
  if (!isConfirmWord(o.confirm)) {
    ctx.out(`REFUSED: the word that starts a plan is ${CONFIRM_WORD}, typed by you after you read the card.`);
    return 1;
  }
  // Review finding (plan.mjs:146 area, later): this sentence existed twice, here and as confirmRefusal's own torn
  // branch, in a fix whose stated aim (cards.mjs:164) was one reader for both. Read from there now (rule 3):
  // ledger0.torn already makes confirmRefusal return unconditionally, before it would ever look at running.
  if (ledger0.torn) {
    ctx.out(`REFUSED: ${confirmRefusal(ledger0, call, null)}`);
    return 1;
  }
  // The buy lock, held while the checks read the ledger and the writes land: a scheduled buy mid-run could otherwise
  // send under the plan this confirm replaces, after the checks passed. takeover false, as buy takes it.
  const release = ctx.store.lock(buyLockName(call), { takeover: false });
  if (!release) {
    ctx.out(`REFUSED: ${staleLockLine(ctx.store, call, { action: 'confirm' }) || `${LOCK_HELD_LINE} Try again in a few minutes.`}`);
    return 1;
  }
  try {
    return await confirmLocked(ctx, call, plan, read.fields, now, pre.ownerTest, pre.ip);
  } finally {
    release();
  }
}

async function confirmLocked(ctx, call, plan, fields, now, ownerTest, ip) {
  const { id, timeZone } = plan;
  const ledger = ctx.store.readLedger();
  if (!freshCard(ledger, call, id, now, CARD_TTL_MS)) {
    ctx.out('REFUSED: show the plan card first. A card is good for 30 minutes and must have exactly these settings.');
    return 1;
  }
  const running = activePlan(ledger, call);
  // Any plan on this account, not only the running one: a stopped or replaced plan's open send is money whose
  // outcome is unknown just the same. Review finding (buy.mjs:157/planview.mjs:73 area): buyVerb never reads a
  // halted plan's own sends back again (it returns at "The plan is halted" before ever taking the lock), so
  // telling the user to wait for the next scheduled run is false for exactly the plan whose halt is most likely
  // to have left one open (a crash between writing plan_halted and marking every open send unknown, buy.mjs's
  // halt()). stop is what actually clears them. Shared with the card's own advisory through confirmRefusal above
  // (rule 3, one fact one reader), on this call's own fresh read (a card can be up to 30 minutes old).
  const refusal = confirmRefusal(ledger, call, running);
  if (refusal) {
    ctx.out(`REFUSED: ${refusal}`);
    return 1;
  }
  // Review finding (manage.mjs:201, should, paths lens): a plan remade before the next scheduled run closes a
  // stale period of its own life (buy.mjs's stalePeriods): a coin filled, no period_done, no notice. Closed here,
  // before the running plan's own plan_stopped line, so money that period already spent still reaches a mail with
  // its details (spec section 9), the same as stop already does.
  // Review finding (plan.mjs:187, buy.mjs:351, period.mjs:216, should): closed with `now - 1`, strictly before the
  // new plan_active line this same call writes below with `now`. A same-id restart (running.id === id, an
  // identical settings hash) shares its planId with the new life, and lastRun's own life filter only ever excludes
  // a line whose ts is strictly earlier than the new life's own start; the same `now` on both lines (the same
  // clock, read twice with no tick between them) would not be excluded, crediting the old life's own closed-out
  // period as this new life's own Last run before its schedule ever ran once.
  if (running) {
    await closeStalePeriods(ctx, call, running, now - 1);
    ctx.store.appendLedger({ kind: 'plan_stopped', planId: running.id, profile: call.profile, env: modeOf(call), reason: `replaced by plan ${id}` }, now);
  }
  const local = localParts(now, timeZone);
  ctx.store.appendLedger({
    kind: 'plan_active', id, profile: call.profile, env: modeOf(call), ...fields, timeZone, anchorDate: local.date, activeFrom: `${local.date} ${hhmm(local.minutes)}`,
  }, now);
  // Review finding (plan.mjs:139): the receipt is the user's last screen before installing the schedule, and used
  // to drop two warnings the card just showed for the same plan.
  const cadence = parseCadence(plan.cadence);
  ctx.out(`AvgKeeper plan ${id} is on.`);
  ctx.out(planLine(plan));
  ctx.out(coinsLine(plan));
  if (cadence && cadence.kind === 'hour') ctx.out(HOURLY_LINE);
  ctx.out(builderDisclosure(ownerTest));
  const keyWarning = keyInactivityWarning(ip, cadence);
  if (keyWarning) ctx.out(keyWarning);
  // Review finding (plan.mjs:205, later): the same gap as the card above; the receipt discarded readConfigSafe's
  // own `line` too.
  const { config, line: configLine } = readConfigSafe(ctx.store);
  if (configLine) ctx.out(`WARNING: ${configLine}`);
  ctx.out(mailLine(config));
  // Review findings (cards.mjs:163, should and later): "It replaces plan X" said a plan replaces itself whenever
  // the confirmed settings hashed to the id already on record (running or halted). A same-id confirm in fact
  // restarts that plan (a fresh plan_active line, its own new anchorDate and activeFrom above), which silently
  // shifts an every-N-days cadence's own future buy days; named here, read the same way the card already reads it
  // (rule 3, restartKind, cards.mjs).
  const kind = restartKind(plan, running);
  // Review finding (cards.mjs, later): a restarted HALTED days:N plan re-anchors its count the same way a healthy
  // same-id restart does, but this never named it; both branches now read the one shared helper the card already
  // reads (rule 3, one fact one reader), which also drops the sentence entirely when today was already the old
  // schedule's own next buy day, so nothing actually moves (rule 2).
  if (kind === 'replaces') ctx.out(`It replaces plan ${running.id}.`);
  else if (kind === 'restartsHalted') ctx.out(`This restarts the plan that was halted; it does not replace a different one.${daysShiftLine(cadence, running, local.date) || ''}`);
  else if (kind === 'restartsSame') ctx.out(`This restarts the plan; it does not replace a different one.${daysShiftLine(cadence, running, local.date) || ''}`);
  // AVGPLAN is the whole job: the plan is already on (the ledger line above), and AvgKeeper installs its own schedule
  // entry now. A failed install never un-confirms the plan; it says so and names what is still needed.
  const installed = await installSchedule(ctx, call, plan);
  if (installed.ok) {
    ctx.out(`Schedule installed (${viaPhrase(installed.via)}): ${installed.wakes}. Output log: ${installed.logPath}.`);
    // The same risks doctor prints (schedule.mjs scheduleRisks): a path a macOS privacy rule or a node upgrade can break.
    for (const r of installed.risks || []) ctx.out(r);
    for (const w of installed.warnings || []) ctx.out(w);
    return 0;
  }
  // Two different truths. Nothing left installed: a new schedule is all that is missing. Cleanup failed too: an entry
  // may be left, so the line says where, and never claims nothing is installed. Either way the plan stays on (the
  // ledger is unchanged) and the exit code is 1, so nothing that reads it mistakes a plan with no schedule for done.
  if (installed.left) ctx.out(`FAIL: the plan is on, but AvgKeeper could not install its schedule (${installed.reason}), and it could not take its own partial work back, so an entry may be left in ${installed.left}. Ask your agent for doctor, which shows what is installed and how to take it out.`);
  // An earlier entry was seen, or could not be looked for, and the failure came before it was touched: it may still
  // run this plan at its own time, so "nothing buys" would be a claim the code has no basis for.
  else if (installed.mayRemain) ctx.out(`FAIL: the plan is on, but AvgKeeper could not install its schedule (${installed.reason}). An earlier AvgKeeper schedule entry may still be installed and would run this plan at its own time. Ask your agent for doctor, which shows what is installed and how to take it out.`);
  else ctx.out(`FAIL: the plan is on, but AvgKeeper could not install its schedule (${installed.reason}). Nothing buys until a schedule exists. Ask your agent for doctor, which prints the line to install yourself.`);
  // Warnings belong to a failed install too (for example the crontab that could not be read on macOS).
  for (const w of installed.warnings || []) ctx.out(w);
  return 1;
}
