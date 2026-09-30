// avgkeeper/scripts/period.mjs
// When a buy is due. A period is the local date of a buy day in the plan's time zone. Nothing here reads the
// network; buy decides whether to call OKX at all from this module and the ledger alone.
import { DAY_MS, MINUTE_MS } from './units.mjs';
import { sameAccount, planLifeStart } from './planview.mjs';
import { ledgerSchema, LEDGER_SCHEMA } from './store.mjs';

const HOUR_MS = 60 * MINUTE_MS;

// Finding L4 of the 2026-09-27 release audit: today's own period (or this hour's, for an hourly plan) is not
// missing the instant its trigger minute begins, only once this many minutes have passed it with still no ledger
// line, so a status check a few seconds after the scheduled run started (while that run is still in preflight,
// reading balances, before it can append anything) never reads as a dead schedule. One constant for both cadences:
// 15 minutes is comfortably inside the hour an hourly plan's own period lasts, so the window never survives past
// the next hour's own trigger.
const MISSING_GRACE_MINUTES = 15;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function parseCadence(s) {
  const t = String(s || '');
  if (t === 'day') return { kind: 'day' };
  if (t === 'hour') return { kind: 'hour' };
  let m = /^days:(\d{1,3})$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n >= 2 && n <= 365 ? { kind: 'days', n } : null;
  }
  m = /^week:([a-z]{3})$/.exec(t);
  if (m) {
    const i = WEEKDAYS.indexOf(m[1]);
    return i >= 0 ? { kind: 'week', weekday: i + 1 } : null;
  }
  m = /^month:(\d{1,2})$/.exec(t);
  if (m) {
    const d = Number(m[1]);
    return d >= 1 && d <= 31 ? { kind: 'month', day: d } : null;
  }
  return null;
}

export function parseAt(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// --at for an hourly plan is the minute past each hour, ':MM' (0-59): an hourly plan has no hour of its own to
// name, so HH:MM (parseAt's own form) is refused for it and this form is refused for every other cadence.
export function parseHourlyAt(s) {
  const m = /^:([0-5]\d)$/.exec(String(s || ''));
  return m ? Number(m[1]) : NaN;
}

const FORMATS = new Map();
export function localParts(ms, timeZone) {
  let f = FORMATS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    FORMATS.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: WEEKDAYS.indexOf(String(p.weekday).toLowerCase()) + 1,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

// The local hour of a time, as an hourly plan's own period key: 'YYYY-MM-DD HH', in the plan's time zone. A local
// wall-clock hour that occurs twice in one calendar day (a DST fall-back) folds to the one key both times, so an
// hourly plan never buys the same repeated hour twice.
export const hourPeriod = (p) => `${p.date} ${String(Math.floor(p.minutes / 60)).padStart(2, '0')}`;

// The period a plan's own cadence keys events by, at a local time (section 10's "one reader for the period of a
// plan at a time"): the local hour for an hourly plan, the local date for every other cadence.
export const periodOf = (cadence, p) => (cadence.kind === 'hour' ? hourPeriod(p) : p.date);

// The most days a cadence can go between two buys: hourly and daily never exceed a day, weekly never exceeds 7, an
// every-N-days plan is exactly N, and a month is always more than 14 even in its shortest form (February, 28).
// Item 6 of the 2026-09-27 release audit: this is the one number that decides whether a cadence can leave OKX
// untouched for OKX's whole API key inactivity window (guards.mjs's keyInactivityWarning). NaN for a
// cadence this build cannot read, which never exceeds anything and so never warns.
export function maxGapDays(cadence) {
  if (!cadence) return NaN;
  switch (cadence.kind) {
    case 'hour': return 0;
    case 'day': return 1;
    case 'days': return cadence.n;
    case 'week': return 7;
    case 'month': return 31;
    default: return NaN;
  }
}

export const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const dayNumber = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS;

// The calendar unit missingPeriods walks by: the day number for every cadence but hour, the day number times 24
// plus the local hour for an hourly one. Reads real local time through localParts (the one reader for it in this
// file), never assumes a day is 24 hours or an hour is 60 minutes.
const calendarUnit = (ms, cadence, timeZone) => {
  const p = localParts(ms, timeZone);
  const day = dayNumber(p.date);
  return cadence.kind === 'hour' ? day * 24 + Math.floor(p.minutes / 60) : day;
};

// Finding L4 of the 2026-09-27 release audit: missingPeriods used to step `t` forward by a fixed 24-hour (or
// one-hour) amount of real time. That is correct on an ordinary day, but a daylight-saving change makes a day 23
// or 25 hours (an hour can likewise repeat once or not occur at all): stepping by a fixed amount can then land the
// next `t` a whole calendar unit further on than intended, walking straight past a date (or hour) that genuinely
// happened without ever visiting it once.
//
// This advances `t` to the first instant whose calendarUnit is exactly one more than `t`'s own, so every calendar
// day (or hour, for an hourly plan) between two visits is walked, whatever its real length turned out to be. The
// ordinary case is the fixed step itself, confirmed by a single extra localParts call; only the one or two days a
// year daylight saving actually changes pay for the short forward search, which reads real time in fine ticks
// until the unit first moves, so it is never fooled by an assumed length. A calendar day always exists (even a
// daylight-saving day is 23 to 25 hours, never zero), so the daily walk always finds `unit + 1`; an hourly walk can
// legitimately have no such hour at all (a spring-forward gap), in which case this finds whatever hour comes next.
function nextCalendarStep(t, cadence, timeZone) {
  const step = cadence.kind === 'hour' ? HOUR_MS : DAY_MS;
  const startUnit = calendarUnit(t, cadence, timeZone);
  const naive = t + step;
  if (calendarUnit(naive, cadence, timeZone) === startUnit + 1) return naive;
  const tick = cadence.kind === 'hour' ? MINUTE_MS : 10 * MINUTE_MS;
  const bound = t + 2 * step;
  for (let probe = t + tick; probe <= bound; probe += tick) {
    if (calendarUnit(probe, cadence, timeZone) > startUnit) return probe;
  }
  return naive; // defensive only: every real IANA zone finds a match well inside `bound` above.
}

export function isBuyDay(parts, cadence, anchorDate) {
  switch (cadence.kind) {
    case 'day':
      return true;
    case 'days': {
      const diff = dayNumber(parts.date) - dayNumber(anchorDate);
      return diff >= 0 && diff % cadence.n === 0;
    }
    case 'week':
      return parts.weekday === cadence.weekday;
    case 'month':
      return parts.d === Math.min(cadence.day, daysInMonth(parts.y, parts.mo));
    default:
      return false;
  }
}

// The ledger kinds that close a period for an account: an order was sent, the period finished, or it was skipped.
// Any plan's line counts, not only this plan's: a plan confirmed after today's buy must not buy the same day again.
export const PERIOD_TOUCHED = new Set(['buy_sent', 'period_done', 'period_skipped']);
const sameAcct = (e, plan) => sameAccount(e, { profile: plan.profile, demo: plan.env === 'demo' }) && e.env === plan.env;

// The cross-plan same-period rule (section 10): periods are compared by the kind of the plan asking, not by the
// kind that wrote each ledger line. An hourly plan's own hour is blocked only by another line naming that exact
// hour key; a daily-or-longer plan is blocked by any line on its date, whether that line is a plain date (another
// daily-or-longer buy) or an hour key on that date (an hourly buy). A plain date and an hour key never compare
// equal, so an hourly plan is never blocked by a same-day daily buy.
export function periodTouched(ledger, plan, cadence, period) {
  const date = period.slice(0, 10);
  const sameHourKind = cadence.kind === 'hour';
  return ledger.some((e) => {
    if (!PERIOD_TOUCHED.has(e.kind) || !sameAcct(e, plan)) return false;
    if (sameHourKind) return e.period === period;
    return String(e.period).slice(0, 10) === date;
  });
}

export function dueNow(now, plan, ledger) {
  const cadence = parseCadence(plan.cadence);
  if (!cadence) return { due: false, why: 'the plan on record cannot be read' };
  const p = localParts(now, plan.timeZone);
  const period = periodOf(cadence, p);
  if (cadence.kind === 'hour') {
    const mm = parseHourlyAt(plan.at);
    if (!Number.isFinite(mm)) return { due: false, why: 'the plan on record cannot be read' };
    const hour = Math.floor(p.minutes / 60);
    const minuteOfHour = p.minutes % 60;
    if (minuteOfHour < mm) return { due: false, why: `the buy minute :${String(mm).padStart(2, '0')} has not come yet this hour` };
    const slot = `${p.date} ${String(hour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (slot < String(plan.activeFrom)) return { due: false, why: "the plan started after this hour's buy minute" };
  } else {
    const at = parseAt(plan.at);
    if (!Number.isFinite(at)) return { due: false, why: 'the plan on record cannot be read' };
    if (!isBuyDay(p, cadence, plan.anchorDate)) return { due: false, why: 'today is not a buy day' };
    if (p.minutes < at) return { due: false, why: `the buy time ${plan.at} has not come yet today` };
    if (`${p.date} ${plan.at}` < String(plan.activeFrom)) return { due: false, why: "the plan started after today's buy time" };
  }
  const touched = periodTouched(ledger, plan, cadence, period);
  if (touched) return { due: false, why: 'this period was already handled' };
  return { due: true, period };
}

// Item 1 of the 2026-09-27 release audit: "Running" alone never says whether the schedule still fires. The plan's
// own last run: the newest of the three PERIOD_TOUCHED kinds for this exact plan, or null when it has never run.
//
// New regression, seen on the owner's demo, 2026-09-28: a plan id is a hash of the plan's own settings alone
// (plan.mjs's planId), so a plan the user stops or halts and remakes with identical settings gets the same id
// back. Reading by planId alone then read the OLD incarnation's own run as THIS new incarnation's "Last run",
// naming a buy the new life's own schedule never made ("Last run: a buy was sent, for 2026-09-28 09, on
// 2026-09-28 09:05", from the old, already-stopped life, printed the moment the new plan started at 11:02).
// Scoped to this plan's own life, from its own plan_active line's ts: planLifeStart (planview.mjs), the same
// instant stalePeriods already starts from (round 3), so both readers start the same life at the same instant.
export function lastRun(ledger, plan) {
  const since = planLifeStart(plan);
  let best = null;
  for (const e of ledger) {
    if (!PERIOD_TOUCHED.has(e.kind) || e.planId !== plan.id) continue;
    if (Number.isFinite(since) && Date.parse(e.ts) < since) continue;
    // >=, not >: a full period can write more than one of the three kinds at the very same millisecond (a
    // buy_sent followed by that same run's period_done), and the ledger's own order, later wins, is the one that
    // actually reflects what the run finished as, not whichever of the tied lines happened to come first.
    if (!best || Date.parse(e.ts) >= Date.parse(best.ts)) best = e;
  }
  return best;
}

// Review finding (period.mjs:225, later): buy_sent is written BEFORE the send itself, so a trailing buy_sent with
// no settle can belong to a run that died before it ever sent anything. "recorded" is the fact this line actually
// proves; round 2 already fixed the same overclaim ("sent") in resolveOpen's own notice (buy.mjs).
const RUN_KIND_WORD = { buy_sent: 'a buy was recorded', period_skipped: 'it skipped' };

// Finding 4 of the 2026-09-27 release-readiness review: period_done is written for a period that bought, for one
// whose every coin was rejected or dropped, and by a later run for a period that stopped partway, so it alone never
// proves money was spent. "it bought" only with a buy_filled line for that same plan and period.
function runWord(ledger, run) {
  if (run.kind !== 'period_done') return RUN_KIND_WORD[run.kind] || run.kind;
  const filled = ledger.some((e) => e.kind === 'buy_filled' && e.planId === run.planId && e.period === run.period);
  return filled ? 'it bought' : 'it finished with no fill recorded';
}

// Review finding (period.mjs:228, later): a period_done a LATER run writes when it closes a stale period (one
// whose own sends already settled before the run that sent them died, buy.mjs's resolveOpen) carries that closing
// run's own timestamp, the newest PERIOD_TOUCHED line for the period, not the time the money actually moved.
// Named by the period's own newest buy_sent or buy_filled instead, whenever period_done has one to read: every
// period_done reaching this (the ordinary path or the stale-period one) has at least one buy_sent behind it, so
// the fallback to period_done's own ts is only for a line this build cannot otherwise explain.
function runTimestamp(ledger, run) {
  if (run.kind !== 'period_done') return Date.parse(run.ts);
  let latest = null;
  for (const e of ledger) {
    if ((e.kind === 'buy_sent' || e.kind === 'buy_filled') && e.planId === run.planId && e.period === run.period) {
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
    }
  }
  return latest === null ? Date.parse(run.ts) : latest;
}

// "Last run: ..." with a local time in the plan's own time zone, or, having never run, when the plan itself
// started instead. One reader for status and doctor (rule 3, one fact one reader).
export function lastRunLine(ledger, plan) {
  const run = lastRun(ledger, plan);
  if (!run) return `Last run: never; the plan started ${plan.activeFrom} (${plan.timeZone}).`;
  const local = localParts(runTimestamp(ledger, run), plan.timeZone);
  return `Last run: ${runWord(ledger, run)}, for ${run.period}, on ${local.date} ${hhmm(local.minutes)} (${plan.timeZone}).`;
}

// How many of this plan's own due periods, since the plan started or since it last ran, carry no
// period_done, period_skipped or buy_sent line: the sign of a schedule that has stopped firing. Walks calendar
// days (or hours, for an hourly plan) forward from that reference to `now`, so a schedule silent for months is
// still counted without reading the ledger once per day. A day (or hour) is judged due the way dueNow itself
// judges the live one: a buy day, at or after the plan's own activeFrom, at or after its own buy time; a period
// earlier than today's (or this hour's) is always fully past, so only today's own minute is ever compared against
// `now`, never a time this walk's own stepping happened to land on. Today's own period (or this hour's) needs
// MISSING_GRACE_MINUTES past its own trigger before it counts (finding L4): the scheduled run itself needs a
// moment to read balances and append its ledger line, and a status check caught in that window is not a dead
// schedule. now: ms.
export function missingPeriods(plan, ledger, now) {
  // Finding 3 of the 2026-09-27 release-readiness review: a halted plan writes no period line by design (buy returns
  // at "The plan is halted" before any ledger write), so its quiet periods say nothing about the schedule; the halt
  // is the cause status and doctor already name. Counting them would state a cause the data never ruled in.
  if (plan.halted) return 0;
  const cadence = parseCadence(plan.cadence);
  const at = cadence ? (cadence.kind === 'hour' ? parseHourlyAt(plan.at) : parseAt(plan.at)) : NaN;
  if (!cadence || !Number.isFinite(at)) return 0;
  const run = lastRun(ledger, plan);
  const from = Date.parse(run ? run.ts : plan.ts);
  if (!Number.isFinite(from) || !(now >= from)) return 0;
  const step = cadence.kind === 'hour' ? HOUR_MS : DAY_MS;
  const nowParts = localParts(now, plan.timeZone);
  const nowPeriod = periodOf(cadence, nowParts);
  const seen = new Set();
  let missing = 0;
  // The loop stops once the computed period passes today's (or this hour's) own period, never at a raw `t <= now`
  // comparison: `from` can sit a little after its own trigger (a run is recorded a few seconds or minutes late),
  // and stepping that offset forward by whole days can walk right past `now` without ever landing a candidate on
  // today's own date. Comparing periods themselves, which only ever move forward one step at a time, always
  // reaches today (or this hour) exactly once. `t <= now + step` is a safety bound only, in case a time zone ever
  // made a period non-monotonic; it should never be what stops this loop. The step itself is a real calendar unit
  // (nextCalendarStep), not a fixed 24 or 1-hour amount of real time, so a daylight-saving change never skips a
  // date (finding L4).
  for (let t = from; t <= now + step; t = nextCalendarStep(t, cadence, plan.timeZone)) {
    const p = localParts(t, plan.timeZone);
    const period = periodOf(cadence, p);
    if (period > nowPeriod) break;
    if (seen.has(period)) continue;
    seen.add(period);
    if (cadence.kind !== 'hour' && !isBuyDay(p, cadence, plan.anchorDate)) continue;
    const slot = cadence.kind === 'hour'
      ? `${p.date} ${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(at).padStart(2, '0')}`
      : `${p.date} ${plan.at}`;
    if (slot < String(plan.activeFrom)) continue;
    const reached = period < nowPeriod
      || (period === nowPeriod
        && (cadence.kind === 'hour' ? nowParts.minutes % 60 : nowParts.minutes) >= at + MISSING_GRACE_MINUTES);
    if (!reached) continue;
    if (!periodTouched(ledger, plan, cadence, period)) missing += 1;
  }
  return missing;
}

// "WARNING: N due periods have no record ...", or null while none is due yet (no warning before the first period
// is due, item 1). One reader for status and doctor.
//
// Review finding (period.mjs:290): "the schedule may have stopped firing" is a cause the code never checked
// (ProjectBuilder rule 2), and is certainly wrong when the schedule fires every time but each run refuses before
// writing any line: a torn ledger line (buy.mjs refuses every buy on one) or a newer schema (gSchema, guards.mjs,
// checked with the same ledgerSchema reader) already explain the silence without guessing at the schedule. Absent
// either of those, the honest answer names both real causes a crontab Mac asleep at the buy time and a removed
// schedule line, rather than picking the one the code has no way to tell from the other.
//
// lockStale: whether the buy lock is currently stale (staleLockLine, planview.mjs), passed by the caller (status
// and doctor already compute it, to print their own WARNING line above this one) rather than read again here: this
// module reads no store and no lock, only the ledger and the plan (module header, "Nothing here reads the
// network"). A stale lock refuses every scheduled run the exact same way a torn ledger line does, before that run
// ever writes a period line, so guessing at the schedule is wrong here too (finding 12 remaining).
export function missingPeriodsWarning(ledger, plan, now, lockStale = false) {
  const missing = missingPeriods(plan, ledger, now);
  if (!missing) return null;
  const since = lastRun(ledger, plan) ? 'since it last ran' : 'since it started';
  const n = missing === 1 ? 'period has' : 'periods have';
  if (ledger.torn) {
    return `WARNING: ${missing} due ${n} no record ${since}: a ledger line could not be read (see the WARNING above), which refuses every buy. Fix or remove that line.`;
  }
  if (!(ledgerSchema(ledger) <= LEDGER_SCHEMA)) {
    return `WARNING: ${missing} due ${n} no record ${since}: a newer AvgKeeper copy already wrote to this ledger, which refuses every buy on this older copy. Update this copy of the skill.`;
  }
  // Review finding (period.mjs:315): "(see the WARNING above)" pointed nowhere: the lock line above this one
  // (staleLockLine's readOnly form) never starts with the word WARNING, unlike ledger.torn's own line just above.
  // Named by what it actually says instead, the same fix already made for mail's own dangling pointer (6dedffa).
  if (lockStale) {
    return `WARNING: ${missing} due ${n} no record ${since}: the buy lock has been held without being freed (see the line above about the buy lock), which refuses every buy while it is held.`;
  }
  // Since AVGPLAN installs the schedule entry itself, doctor reads whether that entry is installed and matches the
  // plan (schedule.mjs readScheduleState). This line cannot know which cause applies, so it names the candidates and
  // points at the one screen that can check the entry.
  return `WARNING: ${missing} due ${n} no record ${since}. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time (crontab skips those), or the schedule entry may be gone. Ask your agent for doctor: it reads whether AvgKeeper's schedule entry is installed and matches this plan.`;
}
