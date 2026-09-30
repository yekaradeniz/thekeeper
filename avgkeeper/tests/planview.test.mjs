// avgkeeper/tests/planview.test.mjs
import './tmp-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stalePeriods, tornWarning, noPlanTornCaveat } from '../scripts/planview.mjs';

// A period whose every buy_sent is already settled (buy_filled, buy_rejected or buy_unknown) but that has no
// period_done: a run that sent and settled its very last order, then died before writing period_done, leaves no
// unsettled send at all (unsettledSends finds nothing), so this is the only way resolveOpen (buy.mjs) finds it.
// Review finding (planview.mjs:185, should): the old wording offered "fixed or removed" as two equal ways to clear
// the warning, never saying that the skipped line can be the plan_stopped or plan_halted that ended a plan, so
// removing it (as the warning itself invites) restarts that plan. Named now, with the fix that actually closes the
// risk: run stop right after removing the line.
// Review finding (manage.mjs:201 area, later): "run stop again" presumes a stop already ran; the skipped line can
// just as well be a plan_halted, which stop never wrote or touched at all.
test('tornWarning names the risk that the skipped line ended a plan, and to run stop after removing it', () => {
  const w = tornWarning({ torn: true, tornLine: 2 }, '/home/ak');
  assert.match(w, /If that line ended a plan \(plan_stopped or plan_halted\), removing it can start that plan again: run stop after you remove it\./);
  assert.doesNotMatch(w, /run stop again after/);
});

// Review finding (manage.mjs:199 area, later): status, holdings and doctor said "no plan is running" as a plain
// fact while a ledger line could not be read, although the skipped line could have been the very plan_active this
// profile never showed as running. stop itself already refuses outright rather than guess.
test('noPlanTornCaveat says nothing while the ledger reads fine, and hedges once it is torn', () => {
  assert.equal(noPlanTornCaveat([]), '');
  assert.equal(noPlanTornCaveat({ torn: true }), ' AvgKeeper cannot be sure: a ledger line could not be read (see the WARNING above).');
});

test('stalePeriods finds a period whose every send is settled with no period_done', () => {
  const plan = { id: 'p1', ts: '2026-10-05T07:00:00.000Z' };
  const ledger = [
    { kind: 'plan_active', id: 'p1', ts: plan.ts },
    { kind: 'buy_sent', planId: 'p1', period: '2026-10-05', clOrdId: 'a', ts: '2026-10-05T07:00:01.000Z' },
    { kind: 'buy_filled', planId: 'p1', period: '2026-10-05', clOrdId: 'a', ts: '2026-10-05T07:00:02.000Z' },
  ];
  assert.deepEqual(stalePeriods(ledger, plan), ['2026-10-05']);
});

test('stalePeriods never counts a period that already has its own period_done', () => {
  const plan = { id: 'p1', ts: '2026-10-05T07:00:00.000Z' };
  const ledger = [
    { kind: 'plan_active', id: 'p1', ts: plan.ts },
    { kind: 'buy_sent', planId: 'p1', period: '2026-10-05', clOrdId: 'a', ts: '2026-10-05T07:00:01.000Z' },
    { kind: 'buy_filled', planId: 'p1', period: '2026-10-05', clOrdId: 'a', ts: '2026-10-05T07:00:02.000Z' },
    { kind: 'period_done', planId: 'p1', period: '2026-10-05', ts: '2026-10-05T07:00:03.000Z' },
  ];
  assert.deepEqual(stalePeriods(ledger, plan), []);
});

// New regression: plan ids are a hash of the plan's own settings alone (plan.mjs's planId), so a plan the user
// remakes with the same settings after a halt gets the halted plan's own id. halt() never writes period_done by
// design, so the OLD incarnation's own buy_sent (settled unknown by the halt) used to still read as THIS new
// incarnation's own stale period, closing a period the new plan never touched and telling the user a run happened
// that did not. Scoped to this plan's own life (its own plan_active line's ts) so a remade plan starts clean.
test('stalePeriods never counts an earlier incarnation\'s own send, from before this plan\'s own plan_active line', () => {
  const plan = { id: 'p1', ts: '2026-10-06T07:00:00.000Z' }; // the new plan_active, confirmed the next day
  const ledger = [
    { kind: 'plan_active', id: 'p1', ts: '2026-10-05T07:00:00.000Z' }, // the old (now-halted) incarnation
    { kind: 'buy_sent', planId: 'p1', period: '2026-10-05', clOrdId: 'a', ts: '2026-10-05T07:00:01.000Z' },
    { kind: 'buy_unknown', planId: 'p1', period: '2026-10-05', clOrdId: 'a', ts: '2026-10-05T07:00:02.000Z' },
    { kind: 'plan_halted', planId: 'p1', ts: '2026-10-05T07:00:02.000Z' },
    { kind: 'plan_active', id: 'p1', ts: plan.ts }, // remade with identical settings: same id
  ];
  assert.deepEqual(stalePeriods(ledger, plan), []);
});

// A buy_sent from this same incarnation (ts at or after plan.ts) still counts, even at the exact same millisecond
// as the plan's own plan_active line (a buy could in principle land in the very same tick it went active).
test('stalePeriods still counts a send at or after this plan\'s own plan_active line', () => {
  const plan = { id: 'p1', ts: '2026-10-06T07:00:00.000Z' };
  const ledger = [
    { kind: 'plan_active', id: 'p1', ts: plan.ts },
    { kind: 'buy_sent', planId: 'p1', period: '2026-10-06', clOrdId: 'a', ts: plan.ts },
    { kind: 'buy_filled', planId: 'p1', period: '2026-10-06', clOrdId: 'a', ts: plan.ts },
  ];
  assert.deepEqual(stalePeriods(ledger, plan), ['2026-10-06']);
});
