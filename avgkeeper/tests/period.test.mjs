// avgkeeper/tests/period.test.mjs
import { T0, TZ, HOUR, DAY } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCadence, parseAt, parseHourlyAt, hhmm, localParts, isBuyDay, dueNow, hourPeriod, periodOf,
  lastRun, lastRunLine, missingPeriods, missingPeriodsWarning, maxGapDays,
} from '../scripts/period.mjs';

test('parseCadence reads the five forms and refuses the rest', () => {
  assert.deepEqual(parseCadence('hour'), { kind: 'hour' });
  assert.deepEqual(parseCadence('day'), { kind: 'day' });
  assert.deepEqual(parseCadence('days:2'), { kind: 'days', n: 2 });
  assert.deepEqual(parseCadence('week:mon'), { kind: 'week', weekday: 1 });
  assert.deepEqual(parseCadence('month:31'), { kind: 'month', day: 31 });
  for (const s of ['days:1', 'days:366', 'week:xyz', 'month:0', 'month:32', 'weekly', 'hourly', '', undefined]) assert.equal(parseCadence(s), null, String(s));
});

test('parseAt and hhmm', () => {
  assert.equal(parseAt('10:00'), 600);
  assert.equal(parseAt('23:59'), 1439);
  for (const s of ['24:00', '9:00', '10:60', '']) assert.ok(Number.isNaN(parseAt(s)), s);
  assert.equal(hhmm(605), '10:05');
});

test('parseHourlyAt reads the minute past the hour and refuses everything else', () => {
  assert.equal(parseHourlyAt(':00'), 0);
  assert.equal(parseHourlyAt(':05'), 5);
  assert.equal(parseHourlyAt(':59'), 59);
  for (const s of ['05', ':60', ':5', '10:00', '', undefined]) assert.ok(Number.isNaN(parseHourlyAt(s)), String(s));
});

test('hourPeriod and periodOf: the hour for an hourly plan, the date for every other cadence', () => {
  const p = localParts(T0, TZ);
  assert.equal(hourPeriod(p), '2026-10-05 10');
  assert.equal(periodOf({ kind: 'hour' }, p), '2026-10-05 10');
  assert.equal(periodOf({ kind: 'day' }, p), '2026-10-05');
});

test('localParts reads Istanbul time', () => {
  const p = localParts(T0, TZ);
  assert.equal(p.date, '2026-10-05');
  assert.equal(p.weekday, 1);
  assert.equal(p.minutes, 600);
});

// Item 6 of the 2026-09-27 release audit: guards.mjs's keyInactivityWarning reads this to know whether a plan's own
// cadence can leave OKX untouched past its 14-day key inactivity window.
test('maxGapDays: hourly and daily never exceed a day, week is 7, days:n is n, a month is always past 14', () => {
  assert.equal(maxGapDays({ kind: 'hour' }), 0);
  assert.equal(maxGapDays({ kind: 'day' }), 1);
  assert.equal(maxGapDays({ kind: 'days', n: 20 }), 20);
  assert.equal(maxGapDays({ kind: 'week', weekday: 1 }), 7);
  assert.ok(maxGapDays({ kind: 'month', day: 1 }) > 14);
  assert.ok(Number.isNaN(maxGapDays(null)));
});

test('isBuyDay for each cadence', () => {
  const mon = localParts(T0, TZ);
  const tue = localParts(T0 + DAY, TZ);
  assert.equal(isBuyDay(mon, { kind: 'day' }, '2026-10-01'), true);
  assert.equal(isBuyDay(mon, { kind: 'week', weekday: 1 }, '2026-10-01'), true);
  assert.equal(isBuyDay(tue, { kind: 'week', weekday: 1 }, '2026-10-01'), false);
  assert.equal(isBuyDay(mon, { kind: 'days', n: 2 }, '2026-10-03'), true);
  assert.equal(isBuyDay(tue, { kind: 'days', n: 2 }, '2026-10-03'), false);
  assert.equal(isBuyDay(mon, { kind: 'days', n: 2 }, '2026-10-07'), false);
  const feb28 = localParts(Date.UTC(2027, 1, 28, 9), TZ);
  assert.equal(isBuyDay(feb28, { kind: 'month', day: 31 }, '2026-10-01'), true);
  assert.equal(isBuyDay(feb28, { kind: 'month', day: 27 }, '2026-10-01'), false);
});

const plan = { id: 'p1', profile: 't', env: 'live', cadence: 'day', at: '10:00', timeZone: TZ, anchorDate: '2026-10-01', activeFrom: '2026-10-01 09:00' };
const acct = { profile: 't', env: 'live' };

test('due at the buy time, not before', () => {
  assert.deepEqual(dueNow(T0, plan, []), { due: true, period: '2026-10-05' });
  const early = dueNow(T0 - HOUR, plan, []);
  assert.equal(early.due, false);
  assert.match(early.why, /has not come yet/);
});

test('a period already touched is not due again', () => {
  for (const kind of ['buy_sent', 'period_done', 'period_skipped']) {
    const r = dueNow(T0, plan, [{ kind, planId: 'p1', period: '2026-10-05', ...acct }]);
    assert.equal(r.due, false, kind);
  }
  assert.equal(dueNow(T0, plan, [{ kind: 'period_done', planId: 'p1', period: '2026-10-04', ...acct }]).due, true);
});

// A plan confirmed after today's buy replaced the plan that bought: the same account must not buy the same day twice.
test("another plan's lines touch the period on the same profile and mode, not on another", () => {
  for (const kind of ['buy_sent', 'period_done', 'period_skipped']) {
    assert.equal(dueNow(T0, plan, [{ kind, planId: 'other', period: '2026-10-05', ...acct }]).due, false, kind);
  }
  assert.equal(dueNow(T0, plan, [{ kind: 'period_done', planId: 'other', period: '2026-10-05', profile: 't', env: 'demo' }]).due, true);
  assert.equal(dueNow(T0, plan, [{ kind: 'period_done', planId: 'other', period: '2026-10-05', profile: 'u', env: 'live' }]).due, true);
});

test("a plan started after today's buy time waits for the next buy day", () => {
  const late = { ...plan, activeFrom: '2026-10-05 11:00' };
  assert.equal(dueNow(T0 + 2 * HOUR, late, []).due, false);
  assert.equal(dueNow(T0 + DAY, late, []).due, true);
});

test('a missed day is never bought later', () => {
  const weekly = { ...plan, cadence: 'week:mon' };
  assert.equal(dueNow(T0 + DAY, weekly, []).due, false);
});

test('an unreadable plan is never due', () => {
  assert.equal(dueNow(T0, { ...plan, cadence: 'hourly' }, []).due, false);
});

// Section 10: hourly cadence.
const hourlyPlan = {
  id: 'ph1', profile: 't', env: 'live', cadence: 'hour', at: ':05', timeZone: TZ, activeFrom: '2026-10-05 09:00',
};

test('hourly: due at :MM, not before', () => {
  const early = dueNow(T0, hourlyPlan, []);
  assert.equal(early.due, false);
  assert.match(early.why, /has not come yet this hour/);
  assert.deepEqual(dueNow(T0 + 5 * 60000, hourlyPlan, []), { due: true, period: '2026-10-05 10' });
});

test("hourly: the plan's own first slot is not before activeFrom", () => {
  const late = { ...hourlyPlan, activeFrom: '2026-10-05 10:10' };
  const stillEarly = dueNow(T0 + 5 * 60000, late, []);
  assert.equal(stillEarly.due, false);
  assert.match(stillEarly.why, /started after this hour's buy minute/);
  assert.deepEqual(dueNow(T0 + HOUR + 5 * 60000, late, []), { due: true, period: '2026-10-05 11' });
});

// A second run later in the confirm hour (a launchd wake catch-up, or the replaced plan's old schedule line, which
// keeps running) is where the slot matters: 10:30 is after activeFrom 10:10, but this hour's 10:05 slot is not.
// The single-digit hour pins the padding: an unpadded '9:05' would sort after '09:10' and read as after activeFrom.
test("hourly: a run later in the confirm hour does not buy for a slot before activeFrom, single-digit hour too", () => {
  const at1010 = dueNow(T0 + 30 * 60000, { ...hourlyPlan, activeFrom: '2026-10-05 10:10' }, []);
  assert.equal(at1010.due, false);
  assert.match(at1010.why, /started after this hour's buy minute/);
  const at0910 = dueNow(T0 - HOUR + 30 * 60000, { ...hourlyPlan, activeFrom: '2026-10-05 09:10' }, []);
  assert.equal(at0910.due, false);
  assert.match(at0910.why, /started after this hour's buy minute/);
});

test('hourly: a plan on record whose minute cannot be read is never due', () => {
  assert.deepEqual(dueNow(T0 + 5 * 60000, { ...hourlyPlan, at: '10:00' }, []), { due: false, why: 'the plan on record cannot be read' });
});

test('hourly: the next hour is due again; a missed hour is never bought later', () => {
  const boughtHour10 = [{
    kind: 'buy_sent', planId: 'ph1', period: '2026-10-05 10', profile: 't', env: 'live',
  }];
  assert.equal(dueNow(T0 + 5 * 60000, hourlyPlan, boughtHour10).due, false);
  // Two hours later (hour 11 was skipped, the Mac asleep through it): hour 12 is due on its own, with no attempt
  // to buy the hour that was missed.
  assert.deepEqual(dueNow(T0 + 2 * HOUR + 5 * 60000, hourlyPlan, boughtHour10), { due: true, period: '2026-10-05 12' });
});

test('hourly: the same hour is blocked whichever plan on the account bought it', () => {
  const other = [{
    kind: 'buy_sent', planId: 'other', period: '2026-10-05 10', profile: 't', env: 'live',
  }];
  assert.equal(dueNow(T0 + 5 * 60000, hourlyPlan, other).due, false);
});

test('the cross-plan same-period rule compares periods of the same kind', () => {
  // An hourly plan is not blocked by a daily plan's date: a plain date and an hour key never compare equal.
  const dailyBoughtToday = [{
    kind: 'buy_sent', planId: 'd1', period: '2026-10-05', profile: 't', env: 'live',
  }];
  assert.equal(dueNow(T0 + 5 * 60000, hourlyPlan, dailyBoughtToday).due, true);

  // A daily plan is blocked on a date any buy happened, hourly or daily.
  const dailyPlan = {
    id: 'd1', profile: 't', env: 'live', cadence: 'day', at: '10:00', timeZone: TZ, anchorDate: '2026-10-01', activeFrom: '2026-10-01 09:00',
  };
  const hourlyBoughtToday = [{
    kind: 'buy_sent', planId: 'ph1', period: '2026-10-05 14', profile: 't', env: 'live',
  }];
  assert.equal(dueNow(T0, dailyPlan, hourlyBoughtToday).due, false);
  assert.equal(dueNow(T0, dailyPlan, []).due, true);
});

// DST: Europe/London puts its clocks back on the last Sunday of October (2026-10-25), so local 01:00-01:59
// happens twice, once as BST (UTC+1) and once as GMT (UTC+0). The two must fold to the same period key, or the
// plan would buy the same wall-clock hour twice.
test('hourly period folds to the same wall-clock hour across a DST fall-back (Europe/London, 2026-10-25)', () => {
  const zone = 'Europe/London';
  const foldPlan = {
    id: 'plf', profile: 't', env: 'live', cadence: 'hour', at: ':30', timeZone: zone, activeFrom: '2026-10-25 00:00',
  };
  const beforeFallback = Date.UTC(2026, 9, 25, 0, 30); // 01:30 BST
  const afterFallback = Date.UTC(2026, 9, 25, 1, 30); // 01:30 GMT, the same wall-clock hour again
  const first = dueNow(beforeFallback, foldPlan, []);
  assert.deepEqual(first, { due: true, period: '2026-10-25 01' });
  const touched = [{
    kind: 'buy_sent', planId: 'plf', period: first.period, profile: 't', env: 'live',
  }];
  assert.equal(dueNow(afterFallback, foldPlan, touched).due, false);
});

// Item 1 of the 2026-09-27 release audit: "Running" alone never says whether the schedule still fires. lastRun,
// lastRunLine and missingPeriods/missingPeriodsWarning are what status and doctor read instead.
const oct1_1000 = Date.UTC(2026, 9, 1, 7, 0); // 10:00 Istanbul, 2026-10-01
const dead = {
  id: 'pd1', profile: 't', env: 'live', cadence: 'day', at: '10:00', timeZone: TZ,
  anchorDate: '2026-10-01', activeFrom: '2026-10-01 10:00', ts: new Date(oct1_1000).toISOString(),
};

test('lastRun and lastRunLine name when the plan itself started while it has never run', () => {
  assert.equal(lastRun([], dead), null);
  assert.equal(lastRunLine([], dead), 'Last run: never; the plan started 2026-10-01 10:00 (Europe/Istanbul).');
});

test('lastRun picks the newest of the three touching kinds, for this plan only, and lastRunLine reads it', () => {
  const ledger = [
    { kind: 'period_done', planId: 'pd1', period: '2026-10-01', ts: new Date(Date.UTC(2026, 9, 1, 7, 1)).toISOString() },
    { kind: 'period_skipped', planId: 'pd1', period: '2026-10-02', ts: new Date(Date.UTC(2026, 9, 2, 7, 1)).toISOString() },
    { kind: 'buy_sent', planId: 'other', period: '2026-10-03', ts: new Date(Date.UTC(2026, 9, 3, 7, 1)).toISOString() },
  ];
  assert.equal(lastRun(ledger, dead).period, '2026-10-02');
  assert.equal(lastRunLine(ledger, dead), 'Last run: it skipped, for 2026-10-02, on 2026-10-02 10:01 (Europe/Istanbul).');
});

// Finding 4 of the 2026-09-27 release-readiness review: period_done alone is no proof of a buy; it is also written
// for a period whose every coin was rejected, and for one a run stopped partway through.
test('lastRunLine says it bought only when a buy_filled line exists for that plan and period', () => {
  const done = { kind: 'period_done', planId: 'pd1', period: '2026-10-01', ts: new Date(Date.UTC(2026, 9, 1, 7, 1)).toISOString() };
  assert.equal(lastRunLine([done], dead), 'Last run: it finished with no fill recorded, for 2026-10-01, on 2026-10-01 10:01 (Europe/Istanbul).');
  const otherPeriod = { kind: 'buy_filled', planId: 'pd1', period: '2026-09-30', ts: done.ts };
  const otherPlan = { kind: 'buy_filled', planId: 'other', period: '2026-10-01', ts: done.ts };
  assert.match(lastRunLine([otherPeriod, otherPlan, done], dead), /^Last run: it finished with no fill recorded, /);
  const filled = { kind: 'buy_filled', planId: 'pd1', period: '2026-10-01', ts: done.ts };
  assert.equal(lastRunLine([filled, done], dead), 'Last run: it bought, for 2026-10-01, on 2026-10-01 10:01 (Europe/Istanbul).');
});

// Review finding (period.mjs:228, later): after a stale period is closed by a LATER run (resolveOpen, buy.mjs),
// the period_done that closing run writes carries ITS OWN timestamp, the newest PERIOD_TOUCHED line, so lastRunLine
// credited the purchase to a time nothing was bought at. Named by the period's own last buy_sent or buy_filled
// instead, whichever is newer, so "Last run" always shows when the money actually moved.
test('lastRunLine credits a stale period\'s own buy time, not the later run that only closed it', () => {
  const sent = {
    kind: 'buy_sent', planId: 'pd1', period: '2026-10-01', clOrdId: 'a', ts: new Date(Date.UTC(2026, 9, 1, 7, 0)).toISOString(),
  };
  const filled = {
    kind: 'buy_filled', planId: 'pd1', period: '2026-10-01', clOrdId: 'a', ts: new Date(Date.UTC(2026, 9, 1, 7, 0)).toISOString(),
  };
  // The closing run's own period_done, an hour later: it made no buy of its own, it only noticed the stale period.
  const done = { kind: 'period_done', planId: 'pd1', period: '2026-10-01', ts: new Date(Date.UTC(2026, 9, 1, 8, 0)).toISOString() };
  assert.equal(
    lastRunLine([sent, filled, done], dead),
    'Last run: it bought, for 2026-10-01, on 2026-10-01 10:00 (Europe/Istanbul).',
  );
});

// Seen on the owner's demo, 2026-09-28: an hourly plan halted, he ran stop, then confirmed a new plan with the same
// settings. A plan id is a hash of the plan's own settings alone (plan.mjs's planId), so the new plan got the
// halted one's own id back. lastRun used to key on planId alone, so doctor's own "Last run" line named a buy the
// OLD, halted life sent at 09:05, before this new life ever started ("Last run: a buy was sent, for 2026-09-28 09,
// on 2026-09-28 09:05"). Scoped to this plan's own life from here, the same instant stalePeriods (planview.mjs,
// round 3) already starts from: plan.ts, the plan's own plan_active line.
const restarted = {
  id: 'pd1', profile: 't', env: 'live', cadence: 'hour', at: ':05', timeZone: TZ,
  anchorDate: '2026-09-28', activeFrom: '2026-09-28 11:02', ts: new Date(Date.UTC(2026, 8, 28, 8, 2)).toISOString(),
};
const oldLifeSent = {
  kind: 'buy_sent', planId: 'pd1', period: '2026-09-28 09', clOrdId: 'a', ts: new Date(Date.UTC(2026, 8, 28, 6, 5)).toISOString(),
};

test('lastRun never credits an earlier incarnation\'s own run, from before this plan\'s own plan_active line', () => {
  assert.equal(lastRun([oldLifeSent], restarted), null);
  assert.equal(lastRunLine([oldLifeSent], restarted), 'Last run: never; the plan started 2026-09-28 11:02 (Europe/Istanbul).');
});

test('lastRun still credits a run at or after this plan\'s own plan_active line', () => {
  const newLifeSent = { kind: 'buy_sent', planId: 'pd1', period: '2026-09-28 12', clOrdId: 'b', ts: restarted.ts };
  assert.equal(lastRun([oldLifeSent, newLifeSent], restarted).period, '2026-09-28 12');
  assert.equal(
    lastRunLine([oldLifeSent, newLifeSent], restarted),
    'Last run: a buy was recorded, for 2026-09-28 12, on 2026-09-28 11:02 (Europe/Istanbul).',
  );
});

// Review finding (period.mjs:225, later): buy_sent is written BEFORE the send itself (buy.mjs), so a run that dies
// between that line and the actual spot place leaves a trailing buy_sent with no settle. "a buy was sent" claims
// more than the ledger proves; round 2 already fixed the same overclaim in resolveOpen's own notice.
test('lastRunLine never claims a buy was sent for a trailing, unsettled buy_sent', () => {
  const plan = {
    id: 'p1', activeFrom: '2026-10-05 08:00', timeZone: TZ, ts: new Date(Date.UTC(2026, 9, 5, 5, 0)).toISOString(),
  };
  const sent = {
    kind: 'buy_sent', planId: 'p1', period: '2026-10-05', clOrdId: 'a', ts: new Date(Date.UTC(2026, 9, 5, 7, 0)).toISOString(),
  };
  assert.equal(
    lastRunLine([sent], plan),
    'Last run: a buy was recorded, for 2026-10-05, on 2026-10-05 10:00 (Europe/Istanbul).',
  );
});

test('missingPeriods is 0 before the plan\'s own first period is even due', () => {
  assert.equal(missingPeriods(dead, [], oct1_1000 - 60000), 0);
  assert.equal(missingPeriodsWarning([], dead, oct1_1000 - 60000), null);
});

// A plan started after that same day's own buy time never owes that day: missingPeriods stays 0 until the next
// day's own trigger genuinely arrives, exactly the way dueNow itself treats a late-started plan.
const lateStart = {
  id: 'pls1', profile: 't', env: 'live', cadence: 'day', at: '10:00', timeZone: TZ,
  anchorDate: '2026-10-01', activeFrom: '2026-10-01 14:00', ts: new Date(Date.UTC(2026, 9, 1, 11, 0)).toISOString(),
};

test('missingPeriods excludes the creation day when the plan started after that day\'s own buy time', () => {
  const oct2Trigger = Date.UTC(2026, 9, 2, 7, 0);
  assert.equal(missingPeriods(lateStart, [], Date.UTC(2026, 9, 1, 11, 0)), 0);
  assert.equal(missingPeriods(lateStart, [], oct2Trigger - 60000), 0);
  // Past the grace window (finding L4), not merely at the trigger minute itself.
  assert.equal(missingPeriods(lateStart, [], oct2Trigger + 16 * 60000), 1);
});

test('missingPeriods counts every due day with no record, for a schedule that never ran', () => {
  const now = Date.UTC(2026, 9, 5, 7, 0) + 16 * 60000; // 10:16 Istanbul, past the grace window: Oct 1-5, all due, none recorded
  assert.equal(missingPeriods(dead, [], now), 5);
  assert.equal(missingPeriodsWarning([], dead, now), 'WARNING: 5 due periods have no record since it started. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time (crontab skips those), or the schedule entry may be gone. Ask your agent for doctor: it reads whether AvgKeeper\'s schedule entry is installed and matches this plan.');
});

// Review finding (period.mjs:349, should): "Run doctor to check it is still installed" sent the user back to
// doctor, which never reads the crontab or launchd's loaded jobs and prints this very sentence itself (SKILL.md and
// smoke both already say smoke "proves the line runs, not that it is installed"). The warning must never promise a
// check the code does not make.
test('missingPeriodsWarning never promises that doctor can check whether the line is installed', () => {
  const now = Date.UTC(2026, 9, 5, 7, 0) + 16 * 60000;
  const w = missingPeriodsWarning([], dead, now);
  assert.doesNotMatch(w, /Run doctor to check it is still installed/);
  assert.match(w, /Ask your agent for doctor: it reads whether AvgKeeper's schedule entry is installed and matches this plan\./);
  assert.doesNotMatch(w, /line doctor prints/);
});

// A run recorded a minute after its own trigger (realistic: the job takes a moment to execute and append) must
// not make the walk overshoot today's own period; this is the case tools/mutate.mjs and buy-line-regression guard.
test('missingPeriods counts only what is actually missing after a run, even when that run landed a minute late', () => {
  const ledger = ['2026-10-01', '2026-10-02', '2026-10-03'].map((period, i) => ({
    kind: 'period_done', planId: 'pd1', period, profile: 't', env: 'live', ts: new Date(Date.UTC(2026, 9, 1 + i, 7, 1)).toISOString(),
  }));
  const now = Date.UTC(2026, 9, 5, 7, 0) + 16 * 60000; // 10:16 Istanbul, past the grace window
  assert.equal(missingPeriods(dead, ledger, now), 2);
  assert.equal(missingPeriodsWarning(ledger, dead, now), 'WARNING: 2 due periods have no record since it last ran. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time (crontab skips those), or the schedule entry may be gone. Ask your agent for doctor: it reads whether AvgKeeper\'s schedule entry is installed and matches this plan.');
});

// Mutation review (2026-09-28), finding period.mjs:282, later: SURVIVED r5-missing-from-plan-start
// (`Date.parse(run ? run.ts : plan.ts)` to `Date.parse(plan.ts)`). Nothing pinned that missingPeriods counts from
// the plan's own LAST RUN, not its start: with the mutant, a sleep the schedule has long since recovered from
// (days 1-3 here) would still warn forever, long after the plan caught up on day 4.
test('missingPeriods counts from the last run, not the plan\'s own start, once it has caught up', () => {
  const day = (n) => new Date(Date.UTC(2026, 9, 1 + n, 7, 0)).toISOString(); // 10:00 Istanbul
  const caughtUp = [
    { kind: 'period_done', planId: 'pd1', period: '2026-10-01', profile: 't', env: 'live', ts: day(0) },
    { kind: 'period_done', planId: 'pd1', period: '2026-10-05', profile: 't', env: 'live', ts: day(4) },
  ];
  const checkAt = Date.UTC(2026, 9, 5, 10, 0); // 13:00 Istanbul on day 4 (2026-10-05), the same day it caught up
  assert.equal(missingPeriods(dead, caughtUp, checkAt), 0);
  // Without day 4's own catch-up run, the same check instant still shows every day missing since day 0.
  const onlyFirstRun = [caughtUp[0]];
  assert.equal(missingPeriods(dead, onlyFirstRun, checkAt), 4);
});

// Finding 3 of the 2026-09-27 release-readiness review: a halted plan buys nothing and records no period by design,
// so none of its periods is missing, and the warning never blames the schedule for the halt.
test('missingPeriods is 0 and the warning null for a halted plan', () => {
  const now = Date.UTC(2026, 9, 5, 7, 0);
  const halted = { ...dead, halted: 'OKX did not accept API key t.' };
  assert.equal(missingPeriods(halted, [], now), 0);
  assert.equal(missingPeriodsWarning([], halted, now), null);
});

// Review finding (period.mjs:290): "the schedule may have stopped firing" is a cause the code never checked, and
// is wrong when every run in fact fires but refuses before writing a line at all (a torn ledger line, or a newer
// schema this copy cannot read). Named for what the code actually knows instead.
test('missingPeriodsWarning names a torn ledger line or a newer schema instead of blaming the schedule', () => {
  const now = Date.UTC(2026, 9, 5, 7, 0) + 16 * 60000;
  const torn = [];
  Object.defineProperty(torn, 'torn', { value: 1 });
  Object.defineProperty(torn, 'tornLine', { value: 3 });
  assert.equal(
    missingPeriodsWarning(torn, dead, now),
    'WARNING: 5 due periods have no record since it started: a ledger line could not be read (see the WARNING above), which refuses every buy. Fix or remove that line.',
  );
  const newerSchema = [{ kind: 'plan_card', v: 2 }];
  assert.equal(
    missingPeriodsWarning(newerSchema, dead, now),
    'WARNING: 5 due periods have no record since it started: a newer AvgKeeper copy already wrote to this ledger, which refuses every buy on this older copy. Update this copy of the skill.',
  );
});

// Finding 12 remaining: a stale buy lock held by a live pid refuses every scheduled run before it ever writes a
// period line, the same "it fires but cannot write" shape as a torn ledger or a newer schema. The code already
// knows about the lock (staleLockLine, planview.mjs); guessing at the schedule instead is wrong here too.
test('missingPeriodsWarning names a stale buy lock instead of blaming the schedule', () => {
  const now = Date.UTC(2026, 9, 5, 7, 0) + 16 * 60000;
  assert.equal(
    missingPeriodsWarning([], dead, now, true),
    'WARNING: 5 due periods have no record since it started: the buy lock has been held without being freed (see the line above about the buy lock), which refuses every buy while it is held.',
  );
  // Without the flag, the honest two-cause sentence stands unchanged.
  assert.equal(
    missingPeriodsWarning([], dead, now, false),
    'WARNING: 5 due periods have no record since it started. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time (crontab skips those), or the schedule entry may be gone. Ask your agent for doctor: it reads whether AvgKeeper\'s schedule entry is installed and matches this plan.',
  );
});

// Review finding (period.mjs:274): missingPeriods was only ever tested with daily and hourly plans; its own
// buy-day filter (isBuyDay) for weekly, monthly and every-N-days plans was unpinned.
test('missingPeriods filters by buy day for a weekly plan: 0 the day before, 1 once the next Monday passes', () => {
  // 2026-10-05 is a Monday (helpers.mjs).
  const weekly = {
    id: 'pw1', profile: 't', env: 'live', cadence: 'week:mon', at: '10:00', timeZone: TZ,
    anchorDate: '2026-10-05', activeFrom: '2026-10-05 10:00', ts: new Date(Date.UTC(2026, 9, 5, 7, 0)).toISOString(),
  };
  const ranMonday = [{ kind: 'period_done', planId: 'pw1', period: '2026-10-05', profile: 't', env: 'live', ts: new Date(Date.UTC(2026, 9, 5, 7, 1)).toISOString() }];
  assert.equal(missingPeriods(weekly, ranMonday, Date.UTC(2026, 9, 11, 9, 0)), 0, 'Sunday: the next Monday has not come yet');
  assert.equal(missingPeriods(weekly, ranMonday, Date.UTC(2026, 9, 12, 7, 20)), 1, 'the next Monday, past the grace window');
});

test('missingPeriods filters by buy day for a monthly plan, clamped to the shorter month', () => {
  // month:31 clamps to day 30 in a 30-day month (daysInMonth).
  const monthly = {
    id: 'pm1', profile: 't', env: 'live', cadence: 'month:31', at: '12:00', timeZone: TZ,
    anchorDate: '2026-10-31', activeFrom: '2026-10-31 12:00', ts: new Date(Date.UTC(2026, 9, 31, 9, 0)).toISOString(),
  };
  const ranOct31 = [{ kind: 'period_done', planId: 'pm1', period: '2026-10-31', profile: 't', env: 'live', ts: new Date(Date.UTC(2026, 9, 31, 9, 1)).toISOString() }];
  assert.equal(missingPeriods(monthly, ranOct31, Date.UTC(2026, 10, 29, 9, 0)), 0, "Nov 29: this month's own day (30) has not come yet");
  assert.equal(missingPeriods(monthly, ranOct31, Date.UTC(2026, 10, 30, 9, 20)), 1, 'Nov 30, past the grace window');
});

test('missingPeriods filters by buy day for an every-3-days plan', () => {
  const every3 = {
    id: 'pe1', profile: 't', env: 'live', cadence: 'days:3', at: '09:00', timeZone: TZ,
    anchorDate: '2026-10-05', activeFrom: '2026-10-05 09:00', ts: new Date(Date.UTC(2026, 9, 5, 6, 0)).toISOString(),
  };
  const ranTwice = [
    { kind: 'period_done', planId: 'pe1', period: '2026-10-05', profile: 't', env: 'live', ts: new Date(Date.UTC(2026, 9, 5, 6, 1)).toISOString() },
    { kind: 'period_done', planId: 'pe1', period: '2026-10-08', profile: 't', env: 'live', ts: new Date(Date.UTC(2026, 9, 8, 6, 1)).toISOString() },
  ];
  assert.equal(missingPeriods(every3, ranTwice, Date.UTC(2026, 9, 10, 9, 0)), 0, 'Oct 10: the next buy day (Oct 11) has not come yet');
  assert.equal(missingPeriods(every3, ranTwice, Date.UTC(2026, 9, 11, 6, 20)), 1, 'Oct 11, past the grace window');
});

test('missingPeriods is 0 for a schedule that ran every due day', () => {
  const ledger = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((period, i) => ({
    kind: 'period_done', planId: 'pd1', period, profile: 't', env: 'live', ts: new Date(Date.UTC(2026, 9, 1 + i, 7, 1)).toISOString(),
  }));
  assert.equal(missingPeriods(dead, ledger, Date.UTC(2026, 9, 5, 7, 0)), 0);
  assert.equal(missingPeriodsWarning(ledger, dead, Date.UTC(2026, 9, 5, 7, 0)), null);
});

// Section 10: the same count for an hourly plan, walking hours instead of days.
test('missingPeriods walks hours for an hourly plan', () => {
  const hourlyDead = {
    id: 'phd1', profile: 't', env: 'live', cadence: 'hour', at: ':05', timeZone: TZ, activeFrom: '2026-10-05 10:00', ts: new Date(T0 + 5 * 60000).toISOString(),
  };
  // Hours 10, 11 and 12 (at :05) are due with nothing recorded by 12:20, past the grace window (finding L4);
  // 13 has not reached its own minute yet.
  assert.equal(missingPeriods(hourlyDead, [], T0 + 2 * HOUR + 20 * 60000), 3);
  assert.equal(missingPeriods(hourlyDead, [], T0 + 2 * HOUR + 4 * 60000), 2);
});

// Finding L4 of the 2026-09-27 release audit: missingPeriods used to count today's own period as missing the
// instant its trigger minute began, before a cron run that fired right on time could possibly have written its
// ledger line yet (it reads balances and places orders first). A grace window fixes that without hiding a
// genuinely dead schedule: past the window, the same period counts.
const graceDaily = {
  id: 'pg1', profile: 't', env: 'live', cadence: 'day', at: '09:00', timeZone: TZ,
  anchorDate: '2026-10-05', activeFrom: '2026-10-05 09:00', ts: new Date(Date.UTC(2026, 9, 5, 6, 0)).toISOString(),
};
test('missingPeriods does not count today until a grace window past its trigger has passed', () => {
  const trigger = Date.UTC(2026, 9, 5, 6, 0); // 09:00 Istanbul
  assert.equal(missingPeriods(graceDaily, [], trigger + 5000), 0); // 09:00:05: the run may still be in preflight
  assert.equal(missingPeriods(graceDaily, [], trigger + 10 * 60000), 0); // 09:10: still inside the window
  assert.equal(missingPeriods(graceDaily, [], trigger + 20 * 60000), 1); // 09:20: past the window
});

// The hourly equivalent: the window has to stay well under the hour, or a plan's own next period would arrive
// before this one is ever allowed to count.
const graceHourly = {
  id: 'pgh1', profile: 't', env: 'live', cadence: 'hour', at: ':05', timeZone: TZ, activeFrom: '2026-10-05 10:00', ts: new Date(T0 + 5 * 60000).toISOString(),
};
test('missingPeriods: the hourly grace window stays well inside the hour', () => {
  const trigger = T0 + 5 * 60000; // 10:05 Istanbul
  assert.equal(missingPeriods(graceHourly, [], trigger + 5000), 0); // 10:05:05
  assert.equal(missingPeriods(graceHourly, [], trigger + 10 * 60000), 0); // 10:15: still inside the window
  assert.equal(missingPeriods(graceHourly, [], trigger + 20 * 60000), 1); // 10:25: past the window
});

// Finding L4: the day walk stepped by a fixed 24 hours, so a spring-forward change skipped a calendar date
// entirely when the plan's own trigger sat near midnight. America/New_York springs forward on 2026-03-08 at
// 02:00 (EST, UTC-5, becomes EDT, UTC-4): a 23:30 trigger the night before, stepped a naive 24 hours, lands at
// 2026-03-09 00:30 EDT, skipping 2026-03-08 altogether.
const springForward = {
  id: 'psf1', profile: 't', env: 'live', cadence: 'day', at: '23:30', timeZone: 'America/New_York',
  anchorDate: '2026-03-07', activeFrom: '2026-03-07 23:30', ts: new Date(Date.UTC(2026, 2, 8, 4, 30)).toISOString(), // 23:30 EST, 2026-03-07
};
test('missingPeriods walks every calendar date across a spring-forward change when the trigger is near midnight', () => {
  const now = Date.UTC(2026, 2, 10, 3, 50); // 2026-03-09 23:50 EDT: March 7, 8 and 9 are all due, none recorded
  assert.equal(missingPeriods(springForward, [], now), 3);
});
