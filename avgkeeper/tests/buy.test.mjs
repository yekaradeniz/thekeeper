// avgkeeper/tests/buy.test.mjs
import {
  makeCtx, fakeExchange, LOSING, SCHEDULED, OWNER, CALL, T0, HOUR, DAY, text, kinds, places, notFound, bal,
} from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OkxError } from '../scripts/runner.mjs';
import { buyVerb, NOT_FOUND_SETTLE_MS, rejectedLine } from '../scripts/buy.mjs';
import { isoMinute } from '../scripts/units.mjs';
import { planVerb } from '../scripts/plan.mjs';
import { stopVerb } from '../scripts/manage.mjs';
import { activePlan, unsettledSends } from '../scripts/planview.mjs';
import { buyClOrdId, orderName } from '../scripts/orders.mjs';
import { planLine } from '../scripts/cards.mjs';
import { OKX_KEY_RULE } from '../scripts/guards.mjs';

const flags = { profile: 't', budget: '10', every: 'day', method: 'weighted' };
const ledgerOf = (ctx) => ctx.store.readLedger();
const planOf = (ctx) => activePlan(ledgerOf(ctx), CALL);
const idFor = (ctx, instId, period = '2026-10-05') => buyClOrdId({ planId: planOf(ctx).id, period, instId, profile: 't', demo: false });
const openOf = (ctx) => unsettledSends(ledgerOf(ctx), planOf(ctx).id);
const LIVE_ROW = { state: 'live', accFillSz: '0', avgPx: '' };
const sizes = (okx) => places(okx).map((c) => [c.args[3], c.args[c.args.indexOf('--sz') + 1]]);

// A plan made at 08:00 Istanbul on 2026-10-05, with the clock then moved to 10:00, the buy time.
async function withPlan(okx, extra = {}, config = { notify: 'cat', notifyLevel: 'all' }) {
  const ctx = makeCtx({ env: OWNER, okx, now: T0 - 2 * HOUR, config });
  await planVerb(ctx, { ...flags, ...extra });
  await planVerb(ctx, { ...flags, ...extra, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  return ctx;
}

test('a hand run is refused', async () => {
  const ctx = makeCtx({ okx: fakeExchange(LOSING) });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /runs only from your own schedule/);
});

test('the due run buys each share and records it', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['ETH-USDT', '6.67'], ['BTC-USDT', '3.33']]);
  assert.ok(places(okx).every((c) => !c.args.includes('--aiBuilderCode')));
  assert.deepEqual(kinds(ctx).slice(-5), ['buy_sent', 'buy_filled', 'buy_sent', 'buy_filled', 'period_done']);
  assert.match(ctx.notified.at(-1), /AvgKeeper bought 2026-10-05: ETH 6\.67 USDT, BTC 3\.33 USDT/);
});

// Item 8 of the 2026-09-26 review: the summary names what OKX actually filled (its notional), not the share this
// run tried to send, matching status.
test('the buy summary names the filled notional, not the sent share', async () => {
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => {
      if (!o) return notFound();
      if (o.instId === 'ETH-USDT') return { state: 'filled', accFillSz: '6.5996', avgPx: '1' };
      const px = LOSING.prices[o.instId];
      const total = (Number(o.sz) / Number(px)).toFixed(8);
      return { state: 'filled', accFillSz: total, avgPx: px };
    },
  });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['ETH-USDT', '6.67'], ['BTC-USDT', '3.33']]);
  assert.match(ctx.notified.at(-1), /AvgKeeper bought 2026-10-05: ETH 6\.60 USDT, BTC 3\.33 USDT/);
});

test('a second run in the same period buys nothing and calls OKX not at all', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  await buyVerb(ctx, { profile: 't' });
  const before = okx.calls.length;
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(okx.calls.length, before);
});

test('before the buy time nothing is read', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  ctx.setNow(T0 - HOUR);
  const before = okx.calls.length;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(okx.calls.length, before);
});

test("weights follow the new day's losses", async () => {
  const balances = LOSING.balances.map((b) => ({ ...b }));
  const okx = fakeExchange({ ...LOSING, balances });
  const ctx = await withPlan(okx);
  await buyVerb(ctx, { profile: 't' });
  okx.calls.length = 0;
  balances[1].spotUplRatio = '-0.03';
  balances[2].spotUplRatio = '-0.19';
  ctx.setNow(T0 + DAY);
  await buyVerb(ctx, { profile: 't' });
  assert.deepEqual(sizes(okx), [['BTC-USDT', '8.64'], ['ETH-USDT', '1.36']]);
});

test('no coin in loss skips the period, notified only at level all', async () => {
  const okx = fakeExchange({ ...LOSING, balances: [LOSING.balances[0], bal('ETH', { eqUsd: '200', spotUplRatio: '0.1' })] });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  assert.equal(ledgerOf(ctx).at(-1).kind, 'period_skipped');
  assert.deepEqual(ctx.notified, []);
});

// Review finding (holdings.mjs:106): an only-these coin the account does not hold at all (a typo) used to skip
// quietly as "no coin in the plan is in loss", the same info-level day as a real no-loss day, so a plan with a
// typo'd only-list would buy nothing forever with no alert. It must skip at problem severity, naming the typo.
test('an only-these coin the account never held skips at problem severity, never a quiet no-loss day', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, { only: 'ETHH' }, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.equal(last.reason, 'ETHH is on your only-these list, but this account does not hold it; not bought.');
  assert.equal(ctx.notified.at(-1), `AvgKeeper skipped 2026-10-05: ${last.reason}`);
});

// Review finding (today.mjs:26, should): a coin in loss whose USDT pair is listed but not live (suspend, preopen)
// was dropped from candidates() as WHY_NO_PAIR before its loss was ever read, and with no other coin in loss the
// period skipped quietly as "no coin in the plan is in loss" at info severity, which the default notify level
// never sends. Both the pair and the loss are real; this must skip at problem severity, naming the state.
test('a suspended pair for the only coin in the plan skips at problem severity, naming the state', async () => {
  const okx = fakeExchange({
    ...LOSING,
    instruments: [
      { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'suspend', minSz: '0.00001', lotSz: '0.00000001' },
      { instId: 'BTC-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.00001', lotSz: '0.00000001' },
      { instId: 'SOL-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.00001', lotSz: '0.00000001' },
    ],
  });
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.doesNotMatch(last.reason, /no coin in the plan is in loss/);
  assert.equal(last.reason, 'ETH is in loss, but its USDT pair is not trading on OKX right now (state suspend); not bought.');
  assert.deepEqual(ctx.notified, [`AvgKeeper skipped 2026-10-05: ${last.reason}`]);
});

// Review finding (holdings.mjs:178, blocker): the not-live check used to run before the dust and loss checks, so
// an in-profit coin whose pair happens to be suspended was named "in loss, but its pair is not trading" on every
// buy day, turning a quiet day for it into a false problem-severity alert beside the coins that did buy.
test('an in-profit coin with a suspended pair is never named "in loss" on a buy day, and stays at info severity', async () => {
  const okx = fakeExchange({
    ...LOSING,
    instruments: [
      { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.00001', lotSz: '0.00000001' },
      { instId: 'BTC-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.00001', lotSz: '0.00000001' },
      { instId: 'SOL-USDT', quoteCcy: 'USDT', state: 'suspend', minSz: '0.00001', lotSz: '0.00000001' },
    ],
  });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 2);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_done');
  assert.doesNotMatch(text(ctx), /SOL is in loss/);
  assert.deepEqual(ctx.notified, [], 'SOL is in profit, so this stays a quiet info-level buy, never notified at level problems');
});

// Review finding (cards.mjs:84, should): an only-these coin left out for a configuration reason (here, no USDT
// pair at all) never reaches the loss check; "no coin in the plan is in loss" is false for it, and the plan would
// buy nothing forever with no alert at the default severity.
test('an only-these coin with no USDT pair at all skips at problem severity, never a quiet no-loss day', async () => {
  const okx = fakeExchange({
    ...LOSING,
    balances: [...LOSING.balances, bal('XYZ', { eqUsd: '50', spotUplRatio: '-0.30' })],
  });
  const ctx = await withPlan(okx, { only: 'XYZ' }, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.equal(last.reason, 'XYZ has no USDT spot pair on OKX; not bought.');
  assert.equal(ctx.notified.at(-1), `AvgKeeper skipped 2026-10-05: ${last.reason}`);
});

// Item 2 of the 2026-09-27 release audit: OKX going quiet on spotUplRatio for the only coin held must not read as
// the same quiet "no coin in loss" info line, and must not buy nothing forever with no alert.
test('a period where OKX sent no readable loss figure for any coin is a problem, not a quiet no-loss day', async () => {
  const okx = fakeExchange({ ...LOSING, balances: [LOSING.balances[0], bal('ETH', { eqUsd: '200', spotUplRatio: '' })] });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.equal(last.reason, 'OKX sent no profit or loss figure for ETH, so AvgKeeper cannot tell whether it is in loss; not bought.');
  assert.match(ctx.notified.at(-1), /OKX sent no profit or loss figure for ETH/);
});

// 2026-09-27 release-readiness review, finding 1: a known reason (in profit, dust) beside an unreadable coin is no
// evidence about the unreadable one. A coin left out for an unreadable price had already passed the loss check, so
// "no coin in the plan is in loss" is false for it. Every such coin is named, at problem severity, whatever else
// the account holds.
test('coins left out for an unreadable price beside an in-profit coin are named at problem severity, never a quiet no-loss day', async () => {
  const okx = fakeExchange({ ...LOSING, prices: { ...LOSING.prices, 'ETH-USDT': '', 'BTC-USDT': '' } });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.equal(last.reason, 'ETH, BTC are in loss, but their price or order size could not be read from OKX; not bought.');
  assert.equal(ctx.notified.at(-1), `AvgKeeper skipped 2026-10-05: ${last.reason}`);
});

test('a coin with no loss figure beside a dust coin is named at problem severity, never a quiet no-loss day', async () => {
  const okx = fakeExchange({
    ...LOSING,
    balances: [LOSING.balances[0], bal('PEPE', { eqUsd: '0.50', spotUplRatio: '-0.60' }), bal('BTC', { eqUsd: '800', spotUplRatio: '' })],
  });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.reason, 'OKX sent no profit or loss figure for BTC, so AvgKeeper cannot tell whether it is in loss; not bought.');
  assert.match(ctx.notified.at(-1), /^AvgKeeper skipped 2026-10-05: OKX sent no profit or loss figure for BTC/);
});

// Item 2: on a day that does buy for the readable coins, a coin left out for an unreadable figure is named in the
// summary and forces problem severity, so it reaches a notify command set to level problems. Finding 2 of the
// 2026-09-27 release-readiness review: BTC's loss was read (-5%); only its price was not, and the words say so.
test('a coin left out for an unreadable price is named in the buy summary at problem severity', async () => {
  const okx = fakeExchange({ ...LOSING, prices: { ...LOSING.prices, 'BTC-USDT': '' } });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['ETH-USDT', '10.00']]);
  const summary = ctx.notified.at(-1);
  assert.equal(summary, 'AvgKeeper bought 2026-10-05: ETH 10.00 USDT. BTC is in loss, but its price or order size could not be read from OKX; not bought.');
});

test('too little free USDT skips the whole period, no partial buy', async () => {
  const okx = fakeExchange({ ...LOSING, balances: [bal('USDT', { availBal: '9.99', spotUplRatio: '' }), ...LOSING.balances.slice(1)] });
  const ctx = await withPlan(okx);
  await buyVerb(ctx, { profile: 't' });
  assert.equal(places(okx).length, 0);
  assert.match(ledgerOf(ctx).at(-1).reason, /free USDT 9\.99, below the 10\.00 USDT/);
  assert.match(ctx.notified.at(-1), /skipped 2026-10-05/);
});

test('one rejected coin does not stop the others', async () => {
  const okx = fakeExchange({ ...LOSING, placeReply: (args) => (args[3] === 'ETH-USDT' ? [{ sCode: '51008', sMsg: 'Insufficient balance' }] : null) });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 2);
  assert.deepEqual(kinds(ctx).slice(-5), ['buy_sent', 'buy_rejected', 'buy_sent', 'buy_filled', 'period_done']);
  assert.match(ctx.notified.at(-1), /ETH-USDT: OKX rejected the buy \(Insufficient balance\)/);
});

// Review finding (orders.mjs:33): sCode null or blank on the send's own reply row is not OKX naming a rejection,
// only that it sent no usable code (the runner's own sCodeRejection safety net follows the same rule). The order
// may have landed, so it must be read back, never recorded straight as buy_rejected with "Nothing spent on it."
test('an sCode of null or blank on the send itself is read back, never recorded as a rejection', async () => {
  for (const sCode of [null, '']) {
    const okx = fakeExchange({
      ...LOSING,
      placeReply: (args) => {
        okx.orders.set(args[args.indexOf('--clOrdId') + 1], { instId: args[3], sz: args[args.indexOf('--sz') + 1] });
        return [{ sCode, sMsg: '' }];
      },
    });
    const ctx = await withPlan(okx, { only: 'ETH' });
    assert.equal(await buyVerb(ctx, { profile: 't' }), 0, JSON.stringify(sCode));
    assert.ok(!kinds(ctx).includes('buy_rejected'), JSON.stringify(sCode));
    assert.ok(kinds(ctx).includes('buy_filled'), JSON.stringify(sCode));
  }
});

test('an unreadable fill halts the plan and later runs buy nothing', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? { state: 'filled', fillSz: '', avgPx: '' } : notFound()) });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.ok(kinds(ctx).includes('buy_unknown'));
  assert.ok(activePlan(ledgerOf(ctx), CALL).halted);
  assert.match(ctx.notified.at(-1), /HALTED/);
  const n = places(okx).length;
  ctx.setNow(T0 + DAY);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, n);
});

// New regression (buy.mjs:187): halt() wrote plan_halted, then awaited tell() (the notify child can take up to
// NOTIFY_TIMEOUT_MS, the mail command another), and only after that wrote the send's own buy_unknown. A run killed
// in that window leaves a halted plan holding a send the ledger never marked unknown. Both ledger writes must land
// before any child process runs.
test('halt writes buy_unknown before the notify command ever runs', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? { state: 'filled', fillSz: '', avgPx: '' } : notFound()) });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'all' });
  let seenAtNotify = null;
  const realNotify = ctx.runNotify;
  ctx.runNotify = async (cmd, line) => {
    seenAtNotify = kinds(ctx);
    return realNotify(cmd, line);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.ok(seenAtNotify, 'the notify command must have run');
  assert.ok(seenAtNotify.includes('plan_halted'), seenAtNotify.join(','));
  assert.ok(seenAtNotify.includes('buy_unknown'), seenAtNotify.join(','));
});

// Review finding (buy.mjs:212, "Probe P1"): a read-back with no state at all (or one OKX never documents as
// final) used to read as a finished order with nothing filled, settling the send as buy_rejected. That was fixed
// to wait and read the row again, but with no time limit and no halt: the send stayed unsettled forever, so every
// later period was skipped with two problem notices apiece (30 daily runs: 1 place sent, 29 skipped). New
// regression: by the time this branch is reached, stillOnTheBook has already ruled out live/partially_filled, so a
// row with no documented final state is not a row still settling either; OKX answered something this build cannot
// read as finished at all, the same class of answer as an unreadable fill (spec lines 75 and 96). It halts the
// plan now, instead of waiting forever.
test('a read-back with no state halts the plan, instead of waiting forever and skipping every later period', async () => {
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => (o ? { clOrdId: id, accFillSz: '0', avgPx: '' } : notFound()),
  });
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.deepEqual(kinds(ctx).slice(-3), ['buy_sent', 'plan_halted', 'buy_unknown']);
  assert.ok(!kinds(ctx).includes('buy_rejected'));
  const halted = activePlan(ledgerOf(ctx), CALL).halted;
  // Review finding (buy.mjs:251, later): the old wording spliced the error in as "answered with its own state
  // ((none)) is not one OKX documents as finished", ungrammatical and double-parenthesised.
  assert.match(halted, /buy answered with no state at all, so AvgKeeper cannot say what it spent\./, halted);
  assert.match(ctx.notified.at(-1), /HALTED/);
  // A halted plan never sends again, even the next day.
  const n = places(okx).length;
  ctx.setNow(T0 + DAY);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, n);
});

// Review finding (orders.mjs:93, should): a row OKX marks state 'filled' with accFillSz '0' contradicts itself.
// The old fillOf picked accFillSz over state and recorded a clean buy_rejected ("the order finished without
// filling"); this halts instead, the same as any other self-contradicting or unreadable fill.
test('a "filled" read-back with accFillSz 0 halts the plan, never a clean rejection', async () => {
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => (o ? { clOrdId: id, state: 'filled', accFillSz: '0', avgPx: '1767.30' } : notFound()),
  });
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.deepEqual(kinds(ctx).slice(-3), ['buy_sent', 'plan_halted', 'buy_unknown']);
  assert.ok(!kinds(ctx).includes('buy_rejected'));
  const halted = activePlan(ledgerOf(ctx), CALL).halted;
  assert.match(halted, /it reads as filled with a filled size of 0, so AvgKeeper cannot say what it spent\./, halted);
});

// Review finding (buy.mjs:251, later): the same halt with an actual, defined state OKX just does not document as
// finished must read as a plain clause too, not "answered with its own state (weird_state) is not one OKX
// documents as finished" (missing "which").
test('a read-back with a defined but undocumented state halts with a grammatical sentence naming that state', async () => {
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => (o ? { clOrdId: id, state: 'weird_state', accFillSz: '0', avgPx: '' } : notFound()),
  });
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  const halted = activePlan(ledgerOf(ctx), CALL).halted;
  assert.match(halted, /buy answered with state weird_state, which OKX does not document as finished, so AvgKeeper cannot say what it spent\./, halted);
});

// Review finding (buy.mjs:157): the halt used to mark OTHER open sends unknown and only then write plan_halted,
// so a crash between those two appends left the ledger with a settled-unknown send but no plan_halted line: the
// plan still read as active, and the next day sent a fresh order for the same account. plan_halted must be the
// halt's own first write, so a crash right after it still leaves the plan halted (fail closed, spec section 5:
// never continue after a money move whose outcome is unknown). Two coins are needed to expose this: with only one
// open send, the old code had no "other opens" to mark and plan_halted already happened to land right after it.
test('a store that throws on every append after the first still leaves the plan halted, and no send the next day', async () => {
  let ethId = null;
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => (o ? (id === ethId ? { state: 'filled', accFillSz: '', avgPx: '' } : null) : notFound()),
  });
  const ctx = await withPlan(okx);
  ethId = idFor(ctx, 'ETH-USDT');
  const btcId = idFor(ctx, 'BTC-USDT');
  for (const [instId, clOrdId] of [['ETH-USDT', ethId], ['BTC-USDT', btcId]]) {
    ctx.store.appendLedger({
      kind: 'buy_sent', planId: planOf(ctx).id, period: '2026-10-05', instId, clOrdId, amount: '5.00', lossPct: 5, profile: 't', env: 'live',
    }, T0);
    okx.orders.set(clOrdId, { instId, sz: '5.00' });
  }
  const realAppend = ctx.store.appendLedger.bind(ctx.store);
  let count = 0;
  ctx.store.appendLedger = (entry, now) => {
    count += 1;
    if (count > 1) throw new Error('ENOSPC (simulated)');
    realAppend(entry, now);
  };
  ctx.setNow(T0 + HOUR);
  await assert.rejects(buyVerb(ctx, { profile: 't' }));
  ctx.store.appendLedger = realAppend;
  assert.ok(planOf(ctx).halted, 'the plan must be halted even though every append after the first failed');
  const n = places(okx).length;
  ctx.setNow(T0 + DAY);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, n, 'a halted plan must never send a new order the next day');
});

// New regression (buy.mjs:316): resolveOpen always opened its catch-up notice with "AvgKeeper read back earlier
// orders:", even when the run read nothing back at all: a stale period is found by its own already-settled
// buy_sent, never by an order this run actually read. Probe P7d: appendLedger throws on BTC's buy_sent (it is
// never recorded at all), right after ETH's buy_filled, so the next run has nothing unsettled to read back.
test('a stale-only catch-up notice never claims a read-back that never happened', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const realAppend = ctx.store.appendLedger.bind(ctx.store);
  let count = 0;
  ctx.store.appendLedger = (entry, now) => {
    count += 1;
    if (count > 2) throw new Error('ENOSPC (simulated)');
    realAppend(entry, now);
  };
  await assert.rejects(buyVerb(ctx, { profile: 't' }));
  ctx.store.appendLedger = realAppend;
  assert.deepEqual(kinds(ctx).slice(-2), ['buy_sent', 'buy_filled'], 'only ETH landed; BTC\'s own send was never recorded');
  ctx.notified.length = 0;
  ctx.lines.length = 0;
  ctx.setNow(T0 + 30 * 60000);
  const callsBefore = okx.calls.length;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(okx.calls.length, callsBefore, 'nothing was unsettled to read back, so this run must make no OKX call');
  assert.match(ctx.notified.at(-1), /^AvgKeeper closed an earlier period: The run for 2026-10-05 stopped partway; it had recorded these orders: ETH-USDT\.$/);
  assert.doesNotMatch(ctx.notified.at(-1), /read back/);
});

// New regression (buy.mjs:312): when every buy_sent of a stale period is excluded because OKX confirmed none of
// them ever landed, the notice said the run "stopped partway with nothing recorded for it", although the ledger
// plainly holds that period's own buy_sent and the same notice already names the coin one sentence earlier. Probe
// P8: plan limited to ETH; the store records the buy_sent but the run dies right after, so spot place never runs.
// Review finding (buy.mjs:31, should): WAIT_LINE ("the order is still open or not found yet") was the one sentence
// used for every 'wait' verdict, including a read-back that failed on the network, which settle()'s own screen
// print already tells apart from the two causes that generic line names. Only the vaguer line used to reach the
// buy summary and notify.
test('a network failure reading back a just-sent order says so in the summary and notify, never "still open or not found"', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  const json = okx.json;
  let getCalls = 0;
  okx.json = async (args, call) => {
    if (args[0] === 'spot' && args[1] === 'get') {
      getCalls += 1;
      if (getCalls === 1) return json(args, call); // the pre-send existing-order check: not sent yet
      throw new OkxError('connect ECONNREFUSED', 'network');
    }
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const netLine = 'ETH-USDT: the order could not be read back yet (AvgKeeper could not reach OKX). The next run reads it again.';
  const summary = ctx.lines.find((l) => l.startsWith('AvgKeeper bought'));
  assert.ok(summary && summary.includes(netLine), summary);
  assert.doesNotMatch(summary, /still open or not found yet/);
  assert.match(ctx.notified.at(-1), new RegExp(netLine.replace(/[.()]/g, '\\$&')));
  assert.doesNotMatch(ctx.notified.at(-1), /still open or not found yet/);
});

test('a period whose only send OKX confirmed never landed says so, not "nothing recorded"', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, { only: 'ETH' });
  const realAppend = ctx.store.appendLedger.bind(ctx.store);
  let count = 0;
  ctx.store.appendLedger = (entry, now) => {
    count += 1;
    realAppend(entry, now);
    if (count === 1) throw new Error('ENOSPC (simulated)');
  };
  await assert.rejects(buyVerb(ctx, { profile: 't' }));
  ctx.store.appendLedger = realAppend;
  assert.equal(kinds(ctx).at(-1), 'buy_sent');
  assert.equal(places(okx).length, 0, 'spot place must never have run');
  ctx.notified.length = 0;
  ctx.lines.length = 0;
  ctx.setNow(T0 + NOT_FOUND_SETTLE_MS + 60000);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const notice = ctx.notified.at(-1);
  assert.match(notice, /ETH-USDT for 2026-10-05: did not go through\. Nothing spent on it\./);
  // Review finding (buy.mjs:312, later): "OKX confirmed it never received" states more than a 51603 answer proves.
  // NOT_FOUND_SETTLE_MS's own comment says OKX also drops a cancelled order that never filled after about 2 hours,
  // so the fact this run actually checked is "nothing spent", not "never received".
  assert.match(notice, /The run for 2026-10-05 stopped partway; OKX has no order with any of its ids, at least 2 hours after each send\. Nothing was spent on them\./);
  assert.doesNotMatch(notice, /confirmed it never received/);
  assert.doesNotMatch(notice, /nothing recorded for it/);
});

test('a send that timed out but reached OKX is found by its client id', async () => {
  const okx = fakeExchange({
    ...LOSING,
    placeReply: (args) => {
      okx.orders.set(args[args.indexOf('--clOrdId') + 1], { instId: args[3], sz: args[args.indexOf('--sz') + 1] });
      return new OkxError('okx spot place timed out', 'timeout');
    },
  });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(kinds(ctx).filter((k) => k === 'buy_filled').length, 2);
});

test('an order still on the book is left open and read back by the next run', async () => {
  let state = 'live';
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => (o ? { state, accFillSz: state === 'live' ? '0' : '0.001', avgPx: state === 'live' ? '' : '1767.30' } : notFound()),
  });
  const ctx = await withPlan(okx, { only: 'ETH' });
  await buyVerb(ctx, { profile: 't' });
  assert.deepEqual(kinds(ctx).slice(-2), ['buy_sent', 'period_done']);
  state = 'filled';
  ctx.setNow(T0 + HOUR);
  await buyVerb(ctx, { profile: 't' });
  assert.equal(kinds(ctx).at(-1), 'buy_filled');
  assert.equal(places(okx).length, 1);
});

test('an auth failure halts the plan', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  okx.json = async () => { throw new OkxError('Error: Invalid OK-ACCESS-KEY', 'auth'); };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.ok(activePlan(ledgerOf(ctx), CALL).halted);
});

// Item 6 of the 2026-09-27 release audit: the halt names OKX's own key inactivity rule as one thing that can cause
// an auth failure, as a hedge ("if"), never as the diagnosed cause (ProjectBuilder CLAUDE.md rule 2: this run never
// read whether the key actually had no IP bound before the key itself stopped answering).
test('an auth failure names the OKX key inactivity rule as a possible cause, not a diagnosis', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  okx.json = async () => { throw new OkxError('Error: Invalid OK-ACCESS-KEY', 'auth'); };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  const halted = activePlan(ledgerOf(ctx), CALL).halted;
  assert.ok(halted.startsWith(`OKX did not accept API key t (Invalid OK-ACCESS-KEY). ${OKX_KEY_RULE} If this key has no IP address bound to it, that rule is one possible cause; check the key on the OKX website.`), halted);
});

// Review findings (buy.mjs:148 should, buy.mjs:160 later): an auth failure after an earlier coin in the SAME
// period already filled used to halt with no period at all, because locked()'s own `due` was declared inside its
// try block, unreachable from the catch. The halt line never named the money this period already spent, and the
// mail notice ("money spent reaches a mail with its details on every path", spec section 9) carried no detail line
// for it. Probe P7: ETH sends and fills; BTC's pre-send existing-order check then throws an auth error.
test('an auth failure after an earlier coin filled names what this period already bought, and mails its detail line', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'all', command: 'cat' } });
  const btcId = idFor(ctx, 'BTC-USDT');
  const realJson = okx.json.bind(okx);
  okx.json = async (args, call) => {
    if (args[0] === 'spot' && args[1] === 'get' && args[args.indexOf('--clOrdId') + 1] === btcId) {
      throw new OkxError('Error: Invalid OK-ACCESS-KEY', 'auth');
    }
    return realJson(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.deepEqual(kinds(ctx).filter((k) => ['buy_sent', 'buy_filled', 'plan_halted'].includes(k)), ['buy_sent', 'buy_filled', 'plan_halted']);
  const halted = activePlan(ledgerOf(ctx), CALL).halted;
  assert.match(halted, /Before it halted, this period bought: ETH 6\.67 USDT\./, halted);
  assert.equal(ctx.mailed.length, 1);
  assert.match(ctx.mailed[0].body, /ETH-USDT: share 6\.67 USDT/, ctx.mailed[0].body);
});

// Review finding (buy.mjs:145, probe K1): the okx CLI has no key saved locally at all ("Error: No credentials
// found."). OKX was never called, so the halt must never say "OKX did not accept" and never cite OKX's 14-day
// key-deletion rule (a cause the code did not check): it names the local, missing key the way holdings already does.
test('a scheduled run with no key saved locally halts naming the missing local key, never "OKX did not accept" or the 14-day rule', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const text = 'Error: No credentials found.\n';
  okx.json = async () => { throw new OkxError(text, 'auth', text); };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  const halted = activePlan(ledgerOf(ctx), CALL).halted;
  assert.match(halted, /^the okx CLI has no key saved for profile t\. Run okx config init yourself/);
  assert.doesNotMatch(halted, /OKX did not accept|14 days|deletes an API key/);
});

// Review finding (buy.mjs:124): locked()'s own re-check, right after taking the lock, that the plan is still the
// same one, not replaced and not halted, was unpinned. It matters when two runs overlap (cron and launchd both
// installed, say): one halts the plan through a path that writes no period line (locked()'s own auth catch), the
// other already read the ledger before that halt and takes the lock next.
test('a plan halted the instant this run took the lock is never bought on, and locked() catches it fresh', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const planId = planOf(ctx).id;
  const realLock = ctx.store.lock.bind(ctx.store);
  ctx.store.lock = (name, opts) => {
    const release = realLock(name, opts);
    if (release) ctx.store.appendLedger({ kind: 'plan_halted', planId, profile: 't', env: 'live', reason: 'halted by another run while this one waited for the lock' }, ctx.now());
    return release;
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.match(text(ctx), /The plan changed while this run waited\. Nothing was bought\./);
  assert.equal(places(okx).length, 0);
});

// Review finding (buy.mjs:124), the other half: only the halted re-check above was pinned; a plan replaced by
// another confirm while this run waited for the lock (plan.id !== planId) must refuse the buy the same way, not
// carry on and buy under the new plan it just happened to read.
test('a plan replaced by a new confirm the instant this run took the lock is never bought on', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const realLock = ctx.store.lock.bind(ctx.store);
  ctx.store.lock = (name, opts) => {
    const release = realLock(name, opts);
    if (release) ctx.store.appendLedger({ kind: 'plan_active', id: 'p-replaced', profile: 't', env: 'live' }, ctx.now());
    return release;
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.match(text(ctx), /The plan changed while this run waited\. Nothing was bought\./);
  assert.equal(places(okx).length, 0);
});

test('a busy lock buys nothing', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const release = ctx.store.lock('buy-t-live');
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  release();
});

// New regression (buy.mjs:503): the dry run never checked the buy lock, so it could promise a buy the real run
// refuses: a lock older than LOCK_STALE_MS whose pid is alive (a pid reused after a reboot, say) makes every real
// run refuse (takeover false), the same class of gap as the original blocker.
test('a dry run with a stale buy lock says it would not buy, and shows no split', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const lockFile = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, start: 1 }));
  const past = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(lockFile, past, past);
  ctx.env = OWNER;
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Right now it would not buy: The buy lock from .* is still held/);
  assert.doesNotMatch(text(ctx), /If it ran now:/);
  assert.equal(ctx.lines.at(-1), 'buy: dry run, nothing sent.');
  // The real run, right after, refuses for the same reason and sends nothing.
  ctx.env = SCHEDULED;
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /could not buy: a lock from .* is still held/);
  assert.equal(places(okx).length, 0);
});

test('the dry run prints the split and sends nothing', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  ctx.env = OWNER;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.equal(places(okx).length, 0);
  assert.match(text(ctx), /ETH\s+-10\.00%\s+6\.67 USDT/);
  assert.equal(ctx.lines.at(-1), 'buy: dry run, nothing sent.');
});

test('the dry run with no plan still proves OKX answers', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /No plan is running yet; OKX answered this run\. buy --smoke tests the schedule's own environment once a plan exists\./);
  assert.deepEqual(kinds(ctx), []);
});

// Review finding (buy.mjs:442, blocker, case 1): a halted plan's dry run used to show the same split as a healthy
// plan. The real run would refuse before ever reading today's split; the dry run now says so and shows no split.
test('a halted plan\'s dry run says it would skip, and shows no split', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? { state: 'filled', fillSz: '', avgPx: '' } : notFound()) });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  ctx.env = OWNER;
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Right now it would skip: the plan is halted\. Nothing is bought until you make a new plan\./);
  assert.doesNotMatch(text(ctx), /If it ran now:/);
  assert.equal(ctx.lines.at(-1), 'buy: dry run, nothing sent.');
});

// Review finding (buy.mjs:442, later): dryRun called preflight before it ever checked whether the plan is halted.
// The real run returns at "The plan is halted" before ever calling preflight (buyVerb), so a halted plan whose own
// preflight would be unhappy (no AI Builder Code without the owner-test flag) must not show that REFUSED line.
test('a halted plan\'s dry run says it is halted before it ever calls preflight', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? { state: 'filled', fillSz: '', avgPx: '' } : notFound()) });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1); // halts: the fake fill's own price cannot be read
  ctx.env = {}; // no owner-test flag: preflight's own gCode(BUILDER_CODE) would refuse
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Right now it would skip: the plan is halted\. Nothing is bought until you make a new plan\./);
  assert.doesNotMatch(text(ctx), /AI Builder Code/);
});

// Review finding (buy.mjs:442, blocker, case 2): free USDT below the budget used to show the same split as a
// healthy plan, although the real run would skip on that alone. Probe: availBal 5, budget 10.
test('a dry run with free USDT below the budget says it would skip, and shows no split', async () => {
  const okx = fakeExchange({ ...LOSING, balances: [bal('USDT', { availBal: '5.00', spotUplRatio: '' }), ...LOSING.balances.slice(1)] });
  const ctx = await withPlan(okx);
  ctx.env = OWNER;
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Right now it would skip: free USDT 5\.00, below the 10\.00 USDT this buy needs\./);
  assert.doesNotMatch(text(ctx), /If it ran now:/);
  assert.equal(ctx.lines.at(-1), 'buy: dry run, nothing sent.');
  // The real run, right after, skips for the same reason: the dry run's verdict was not a false promise.
  ctx.env = SCHEDULED;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  assert.match(ledgerOf(ctx).at(-1).reason, /free USDT 5\.00, below the 10\.00 USDT/);
});

// Review finding (buy.mjs:442, blocker, case 3): once today's buy already ran, the dry run used to show the same
// split again, as if a second buy would still go through this period.
test('a dry run after today\'s buy already ran says it is not due, and shows no split for the handled period', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  ctx.env = OWNER;
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Not due now: this period was already handled\. With today's balance and prices, at the next buy time it would split:/);
});

// Review finding (buy.mjs:442, blocker): an unsettled send from an earlier period blocks a real buy just the
// same, and the dry run must say so instead of showing a split.
test('a dry run with an earlier order still unsettled says it would skip, and shows no split', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? LIVE_ROW : notFound()) });
  const ctx = await withPlan(okx, { only: 'ETH' });
  await buyVerb(ctx, { profile: 't' });
  const id = idFor(ctx, 'ETH-USDT');
  ctx.env = OWNER;
  ctx.setNow(T0 + DAY);
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), new RegExp(`Right now it would skip: an earlier order's result is not known yet \\(${id}\\); the next run reads it again\\.`));
  assert.doesNotMatch(text(ctx), /If it ran now:/);
});

// Review findings (buy.mjs:595, should/later): the real run reads every unsettled send back before it ever checks
// whether today's period is due (locked() -> resolveOpen), and when it is not due it skips nothing at all: it
// writes no period_skipped, it just returns. Before this, the dry run said "Right now it would skip" for a still
// open send whether or not a period was even due yet, promising a skip the real run at the same moment never makes.
test('a dry run with an earlier order still unsettled, before the buy time, says it is not due yet, never "would skip"', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? LIVE_ROW : notFound()) });
  const ctx = await withPlan(okx, { only: 'ETH' });
  await buyVerb(ctx, { profile: 't' }); // day 1: ETH stays live, unsettled
  const id = idFor(ctx, 'ETH-USDT');
  ctx.env = OWNER;
  ctx.setNow(T0 + DAY - 3 * HOUR); // day 2, 07:00 Istanbul: before today's 10:00 buy time
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.doesNotMatch(text(ctx), /would skip/);
  assert.match(text(ctx), new RegExp(`Not due now: the buy time 10:00 has not come yet today\\. an earlier order's result is not known yet \\(${id}\\); the next run reads it again\\.`));
  // The real run at the same moment adds no ledger line: nothing is due, so nothing is skipped.
  const before = ledgerOf(ctx).length;
  ctx.env = SCHEDULED;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(ledgerOf(ctx).length, before);
});

// Finding 10(a) remaining: the not-due branch never checked the budget at all, so a dry run right after today's
// buy, with free USDT now below the plan's own budget, still promised tomorrow's split; the real run the next day
// skips on the budget alone.
test('a dry run that is not due still shows tomorrow\'s budget shortfall, never a false split', async () => {
  const balances = LOSING.balances.map((b) => ({ ...b }));
  const okx = fakeExchange({ ...LOSING, balances });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  balances[0].availBal = '5.00';
  ctx.env = OWNER;
  ctx.setNow(T0 + HOUR);
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Not due now: this period was already handled\. With today's balance and prices, at the next buy time it would skip: free USDT 5\.00, below the 10\.00 USDT this buy needs\./);
  assert.doesNotMatch(text(ctx), /it would split:/);
  // The real run the next day skips for the same reason: the dry run's verdict was not a false promise.
  ctx.env = SCHEDULED;
  ctx.setNow(T0 + DAY);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.match(ledgerOf(ctx).at(-1).reason, /free USDT 5\.00, below the 10\.00 USDT/);
});

// Finding 10(b) remaining: the dry run checked the budget gate before the no-loss and all-dropped gates, the real
// run (buyPeriod) after them; with both a shortfall and no coin in loss true at once, the two verdicts disagreed
// on which reason to name.
test('a dry run checks no-loss before the budget, matching the order the real run checks them in', async () => {
  const okx = fakeExchange({
    ...LOSING,
    balances: [bal('USDT', { availBal: '5.00', spotUplRatio: '' }), bal('SOL', { eqUsd: '406.24', spotUplRatio: '0.1955' })],
  });
  const ctx = await withPlan(okx);
  ctx.env = OWNER;
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Right now it would skip: no coin in the plan is in loss\./);
  assert.doesNotMatch(text(ctx), /free USDT/);
  // The real run agrees.
  ctx.env = SCHEDULED;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(ledgerOf(ctx).at(-1).reason, 'no coin in the plan is in loss.');
});

// New regression (buy.mjs:525): the finding-10 fix made the dry run say "would skip" for ANY unsettled send, but
// the real run reads it back first (locked() -> resolveOpen) and buys on if it settles. Probe: ETH's send stays
// unsettled (state live) on day 1; day 2, OKX answers a documented final state.
test('a dry run reads an unsettled send back before saying it would skip, matching what the real run finds', async () => {
  let live = true;
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? (live ? LIVE_ROW : null) : notFound()) });
  const ctx = await withPlan(okx, { only: 'ETH' });
  await buyVerb(ctx, { profile: 't' }); // day 1: ETH stays live, unsettled
  live = false; // day 2: OKX now answers a documented final state (the default reply: filled)
  ctx.env = OWNER;
  ctx.setNow(T0 + DAY);
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.doesNotMatch(text(ctx), /would skip/);
  assert.match(text(ctx), /If it ran now:/);
  // The real run at the same moment agrees: it reads the send back, finds it filled, and buys the new period.
  ctx.env = SCHEDULED;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 2);
});

// previewSettle's other branch: a send whose read-back the real run would in fact halt the plan over (an
// unrecognized state, buy.mjs:242) must say so, never "would skip", which promises a next run that never comes.
test('a dry run says it would halt when an unsettled send would in fact halt the plan', async () => {
  let phase = 'live';
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => {
      if (!o) return notFound();
      if (phase === 'live') return LIVE_ROW;
      return { accFillSz: '0', avgPx: '' }; // no documented final state: the real run halts on this
    },
  });
  const ctx = await withPlan(okx, { only: 'ETH' });
  await buyVerb(ctx, { profile: 't' }); // day 1: ETH stays live, unsettled
  phase = 'unreadable';
  ctx.env = OWNER;
  ctx.setNow(T0 + DAY);
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Right now it would halt: an earlier order's result cannot be read as finished\./);
  assert.doesNotMatch(text(ctx), /would skip/);
});

// Review findings (buy.mjs:538, blocker): previewSettle treated only fillOf's 'pending' kind as a halt. A finished
// order (a documented final state) whose own filled size or price cannot be read is fillOf's 'unreadable' kind,
// and settle() halts the plan on that too (buy.mjs:260), so the dry run promising a split here was hiding a halt
// the very next real run would hit.
test('a dry run says it would halt when an unsettled send finished with an unreadable fill', async () => {
  let phase = 'live';
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => {
      if (!o) return notFound();
      if (phase === 'live') return LIVE_ROW;
      return { state: 'filled', accFillSz: '0.005', avgPx: '' }; // finished, but the fill itself cannot be read
    },
  });
  const ctx = await withPlan(okx, { only: 'ETH' });
  await buyVerb(ctx, { profile: 't' }); // day 1: ETH stays live, unsettled
  phase = 'unreadable';
  ctx.env = OWNER;
  ctx.setNow(T0 + DAY);
  ctx.lines.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
  assert.match(text(ctx), /Right now it would halt: an earlier order's result cannot be read as finished\./);
  assert.doesNotMatch(text(ctx), /would skip/);
  assert.doesNotMatch(text(ctx), /If it ran now/);
  // The real run at the same moment agrees: it halts, it never promises and sends a new split.
  ctx.env = SCHEDULED;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /AvgKeeper HALTED:/);
});

// Item 1 of the 2026-09-26 money-path review, and mutant (c): auth thrown only by spot place, after buy_sent.
test('auth thrown by the send halts, settles that send as unknown, names it, and a new plan can replace the plan', async () => {
  const okx = fakeExchange({ ...LOSING, placeReply: () => new OkxError('Error: Invalid OK-ACCESS-KEY', 'auth') });
  const ctx = await withPlan(okx, { only: 'ETH' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  const halted = planOf(ctx);
  assert.ok(halted.halted.includes(`Check order(s) in the OKX app: ${orderName('ETH-USDT', '10.00', '2026-10-05', idFor(ctx, 'ETH-USDT'))}.`), halted.halted);
  assert.deepEqual(openOf(ctx), []);
  assert.equal(ledgerOf(ctx).find((e) => e.kind === 'buy_unknown').error, 'the plan halted before this order was read back');
  ctx.env = OWNER;
  const next = { ...flags, only: 'ETH', method: 'equal' };
  await planVerb(ctx, next);
  assert.equal(await planVerb(ctx, { ...next, confirm: 'AVGPLAN' }), 0);
  const now = planOf(ctx);
  assert.notEqual(now.id, halted.id);
  assert.equal(now.halted, null);
});

test('not found right after a timed-out send waits; a later run settles it only once the send is 2 hours old', async () => {
  const okx = fakeExchange({ ...LOSING, placeReply: () => new OkxError('okx spot place timed out', 'timeout') });
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(kinds(ctx).slice(-2), ['buy_sent', 'period_done']);
  assert.equal(openOf(ctx).length, 1);
  assert.match(ctx.notified.at(-1), /ETH-USDT: OKX has no order with this id yet\. It can still land, so the next run reads it again\./);
  ctx.setNow(T0 + NOT_FOUND_SETTLE_MS - 60000);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(openOf(ctx).length, 1);
  assert.ok(!kinds(ctx).includes('buy_rejected'));
  assert.match(ctx.notified.at(-1), /read back earlier orders: ETH-USDT for 2026-10-05: OKX has no order with this id yet\. It can still land, so the next run reads it again\./);
  ctx.setNow(T0 + NOT_FOUND_SETTLE_MS);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'buy_rejected');
  assert.equal(last.sMsg, 'OKX has no order with this id');
  assert.match(ctx.notified.at(-1), /ETH-USDT for 2026-10-05: did not go through/);
  assert.equal(places(okx).length, 1);
});

test('not found after OKX accepted the send halts the plan as unknown, never as nothing spent', async () => {
  const okx = fakeExchange({ ...LOSING, placeReply: () => [{ sCode: '0', sMsg: '' }] });
  const ctx = await withPlan(okx, { only: 'ETH' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.ok(ledgerOf(ctx).some((e) => e.kind === 'buy_unknown' && /accepted the order, then had no order with this id/.test(e.error)));
  assert.ok(!kinds(ctx).includes('buy_rejected'));
  assert.ok(planOf(ctx).halted);
});

// Review finding (buy.mjs:40): an env mismatch (the okx CLI answered for the wrong account) is worded as "OKX
// could not be read", although OKX was read; the account it answered for was simply the wrong one. skipReason must
// keep the REFUSED sentence's own words, the way it already does for a plan whose own record cannot be read.
test('an env mismatch skips with its own REFUSED sentence, never "OKX could not be read"', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const json = okx.json;
  const refused = "REFUSED: the okx CLI used the demo account for profile t, and this run did not pass --demo. Either pass --demo, or clear demo in that profile's okx config, then run it again.";
  okx.json = async (args, call) => {
    if (args[0] === 'account' && args[1] === 'balance') throw new OkxError(refused, 'env');
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.equal(last.reason, "the okx CLI used the demo account for profile t, and this run did not pass --demo. Either pass --demo, or clear demo in that profile's okx config, then run it again.");
  assert.doesNotMatch(last.reason, /OKX could not be read/);
});

// Review findings (buy.mjs:45, later, both money and truth lenses): skipReason worded every non-REFUSED failure
// as "OKX could not be read", even when OKX was never called at all because the okx CLI itself could not be
// started (kind 'missing', the realistic trigger being an nvm or Homebrew upgrade that removed it, exactly what
// doctor's own version-path warning names). failureLine (guards.mjs) already has NO_CLI_LINE for this fact, and
// the dry run already prints it; the scheduled skip must say the same thing, not a second, wronger sentence.
test('a missing okx CLI skips with the same sentence the dry run already uses, never "OKX could not be read"', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const json = okx.json;
  okx.json = async (args, call) => {
    if (args[0] === 'account' && args[1] === 'config') throw new OkxError('could not start okx: spawn okx ENOENT', 'missing');
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  // Review finding (buy.mjs:56, later): NO_CLI_LINE already opens with "AvgKeeper", and the skip line this reason
  // feeds ("AvgKeeper skipped <period>: ...") already opens with it too; the doubled word is dropped here. The
  // trigger this reason is really about (an nvm or Homebrew upgrade that moved the CLI, or node, out from under a
  // schedule line installed against the old path) is exactly what doctor's own scheduleRisks already fixes;
  // reinstalling the CLI alone does not reinstall the schedule line, so that step is named too.
  assert.equal(last.reason, 'cannot reach OKX: no okx CLI was found on PATH. Install it: npm install -g @okx_ai/okx-trade-cli@1.4.6. If a node or okx upgrade moved it, make the plan again with AVGPLAN, which reinstalls the schedule.');
  assert.doesNotMatch(last.reason, /OKX could not be read/);
  assert.doesNotMatch(last.reason, /^AvgKeeper/);
  assert.match(ctx.notified.at(-1), /skipped 2026-10-05/);
});

test('a network error in the preflight skips the period and notifies', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const json = okx.json;
  okx.json = async (args, call) => {
    if (args[0] === 'account' && args[1] === 'config') throw new OkxError('connect ECONNREFUSED', 'network');
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.match(last.reason, /^OKX could not be read \(AvgKeeper could not reach OKX\)\.$/);
  assert.match(ctx.notified.at(-1), /skipped 2026-10-05/);
  assert.equal(places(okx).length, 0);
});

// Review finding (today.mjs:17, probe P3): an instruments reply with no rows must skip at problem severity as an
// unreadable OKX answer, never quietly at info as "no coin in the plan is in loss" (a fact the code never checked).
test('an instruments reply with no live pairs skips at problem severity, never as a quiet no-loss day', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const json = okx.json;
  okx.json = async (args, call) => (args[0] === 'market' && args[1] === 'instruments'
    ? { env: 'live', profile: call.profile || null, data: [] }
    : json(args, call));
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  // the reason is a clause (runner.mjs clause), so the sentence closes once: "(...pairs).", never "(...pairs.)."
  assert.match(last.reason, /^OKX could not be read \(OKX's market instruments reply named no live USDT spot pairs\)\.$/);
  assert.doesNotMatch(last.reason, /no coin in the plan is in loss/);
  assert.match(ctx.notified.at(-1), /skipped 2026-10-05/);
});

// Review finding (today.mjs:17, probe P4): a balance reply with no readable details array must skip the same way,
// never as an account confirmed to hold nothing.
test('a balance reply with no readable details array skips at problem severity, never as a quiet no-loss day', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const json = okx.json;
  okx.json = async (args, call) => (args[0] === 'account' && args[1] === 'balance'
    ? { env: 'live', profile: call.profile || null, data: [{ totalEq: '2900' }] }
    : json(args, call));
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.match(last.reason, /^OKX could not be read \(OKX's account balance reply could not be read/);
  assert.doesNotMatch(last.reason, /no coin in the plan is in loss/);
  assert.match(ctx.notified.at(-1), /skipped 2026-10-05/);
});

// Item 8 of the 2026-09-27 release audit: a launchd catch-up run right after wake can reach OKX before Wi-Fi is
// back. A single transient network failure in preflight must not close the whole period; a retry seconds later
// (the same run, not a later one) has to be given the chance to work.
test('a transient network error in preflight is retried once and the buy still goes through', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const json = okx.json;
  let configCalls = 0;
  okx.json = async (args, call) => {
    if (args[0] === 'account' && args[1] === 'config') {
      configCalls += 1;
      if (configCalls === 1) throw new OkxError('connect ECONNREFUSED', 'network');
    }
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(configCalls, 2);
  assert.deepEqual(kinds(ctx).slice(-5), ['buy_sent', 'buy_filled', 'buy_sent', 'buy_filled', 'period_done']);
  assert.ok(!ledgerOf(ctx).some((e) => e.kind === 'period_skipped'), 'a transient failure must not skip the period');
});

// Review finding (buy.mjs:315): withNetworkRetry only retried kind 'network', although readOrder's own retryable
// set (and runner.mjs's own write-retry) also treats a timeout and a rate limit as worth trying again. A runner
// timeout in preflight (one okx call past 60 s, plausible right after wake) used to close the whole period on the
// very first failure.
test('a timeout in preflight is retried the same way a network error is, and the buy still goes through', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const json = okx.json;
  let configCalls = 0;
  okx.json = async (args, call) => {
    if (args[0] === 'account' && args[1] === 'config') {
      configCalls += 1;
      if (configCalls === 1) throw new OkxError('okx account config timed out', 'timeout');
    }
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(configCalls, 2);
  assert.ok(!ledgerOf(ctx).some((e) => e.kind === 'period_skipped'), 'a timeout must not skip the period on the first try');
});

// Later item L1 of the 2026-09-27 release-readiness review: one retry 2 s later is short for Wi-Fi to rejoin after a
// launchd catch-up at wake, and a failed second try closes the day for good. The two reads before any send now wait
// 10, 20 and 30 s between tries (reads only; nothing has been sent yet, so waiting is safe for money).
test('the reads before any send wait 10, 20 and 30 seconds between tries before the period is skipped', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const sleeps = [];
  ctx.sleep = async (ms) => { sleeps.push(ms); };
  const json = okx.json;
  let configCalls = 0;
  okx.json = async (args, call) => {
    if (args.join(' ') === 'account config') {
      configCalls += 1;
      if (configCalls <= 3) throw new OkxError('connect ECONNREFUSED', 'network');
    }
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(configCalls, 4);
  assert.deepEqual(sleeps.slice(0, 3), [10000, 20000, 30000]);
  assert.equal(kinds(ctx).at(-1), 'period_done');
  assert.equal(places(okx).length, 2);

  const down = fakeExchange(LOSING);
  const ctx2 = await withPlan(down);
  const sleeps2 = [];
  ctx2.sleep = async (ms) => { sleeps2.push(ms); };
  const downJson = down.json;
  down.json = async (args, call) => {
    if (args.join(' ') === 'account config') throw new OkxError('connect ECONNREFUSED', 'network');
    return downJson(args, call);
  };
  assert.equal(await buyVerb(ctx2, { profile: 't' }), 0);
  assert.deepEqual(sleeps2, [10000, 20000, 30000]);
  assert.equal(kinds(ctx2).at(-1), 'period_skipped');
});

// Same fix, for the read that decides whether a coin's split split can even be computed (todaySplit's own account
// balance call), so both reads a period needs before it ever sends anything are covered.
test('a transient network error reading today\'s split is retried once and the buy still goes through', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const json = okx.json;
  let balanceCalls = 0;
  okx.json = async (args, call) => {
    if (args[0] === 'account' && args[1] === 'balance') {
      balanceCalls += 1;
      if (balanceCalls === 1) throw new OkxError('connect ECONNREFUSED', 'network');
    }
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(balanceCalls, 2);
  assert.ok(!ledgerOf(ctx).some((e) => e.kind === 'period_skipped'));
});

// Item 7: the check for an order already sent (readOrder, before any send) is a different read shape: it answers
// { error, network } rather than throwing. A transient failure there is retried the same way, once.
test('a transient network error checking for an existing order is retried once and the coin is still bought', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, { only: 'ETH' });
  const json = okx.json;
  let getCalls = 0;
  okx.json = async (args, call) => {
    if (args[0] === 'spot' && args[1] === 'get') {
      getCalls += 1;
      if (getCalls === 1) throw new OkxError('connect ECONNREFUSED', 'network');
    }
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  // 1: the existing-order check, network failure. 2: readExisting's own retry, succeeds (not found). 3: the
  // ordinary post-send read-back (readBack), unrelated to this retry, confirming the fill.
  assert.equal(getCalls, 3);
  assert.deepEqual(kinds(ctx).slice(-2), ['buy_filled', 'period_done']);
  assert.equal(ledgerOf(ctx).at(-1).problems, undefined);
});

// Item 7: when the check still fails after the one retry, the coin is dropped (as before), but now that drop is
// recorded on period_done itself, not only in the summary line printed once.
test('an existing-order check that keeps failing drops the coin and records it on period_done', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  const json = okx.json;
  okx.json = async (args, call) => {
    if (args[0] === 'spot' && args[1] === 'get') throw new OkxError('connect ECONNREFUSED', 'network');
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.match(ctx.notified.at(-1), /ETH-USDT: could not check whether this buy was already sent \(AvgKeeper could not reach OKX\); not sent\./);
  const done = ledgerOf(ctx).at(-1);
  assert.equal(done.kind, 'period_done');
  assert.deepEqual(done.problems, [{ instId: 'ETH-USDT', error: 'AvgKeeper could not reach OKX' }]);
  assert.equal(places(okx).length, 0);
});

// Coins dropped below OKX's minimum order were invisible after the plan card: period_done held no trace of them,
// and the summary that reaches notify and the mail notice at level all named only the coin that got bought. A
// weighted plan of ETH (heavy loss) and BTC (light loss) with BTC's own minSz set far above what its share could
// ever buy: BTC is dropped, ETH gets the whole budget, and severity stays info (buying went fine; the drop is
// designed behaviour, not a problem).
test('a coin dropped below OKX\'s minimum order is named in the buy summary and recorded on period_done', async () => {
  const balances = [
    bal('USDT', { eqUsd: '1000', availBal: '1000', openAvgPx: '', spotUplRatio: '' }),
    bal('ETH', { eqUsd: '500', spotUplRatio: '-0.99' }),
    bal('BTC', { eqUsd: '500', spotUplRatio: '-0.01' }),
  ];
  const instruments = [
    { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
    { instId: 'BTC-USDT', quoteCcy: 'USDT', state: 'live', minSz: '1', lotSz: '0.00000001' },
  ];
  const okx = fakeExchange({
    balances, instruments, prices: { 'ETH-USDT': '1767.30', 'BTC-USDT': '84000.0' },
  });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'all' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['ETH-USDT', '10.00']]);
  const summary = ctx.notified.at(-1);
  assert.match(summary, /AvgKeeper bought 2026-10-05: ETH 10\.00 USDT\. Too small for OKX's minimum order: BTC\. Their share went to the others\./);
  const done = ledgerOf(ctx).at(-1);
  assert.equal(done.kind, 'period_done');
  assert.deepEqual(done.dropped, [{ ccy: 'BTC', cents: 10 }]);
});

// Severity stays info (the summary above still reaches notify at level all, never problems), so at level problems
// nothing is sent for a buy whose only issue is a designed drop.
test('a period with a dropped coin but no other problem stays info: nothing reaches notify at level problems', async () => {
  const balances = [
    bal('USDT', { eqUsd: '1000', availBal: '1000', openAvgPx: '', spotUplRatio: '' }),
    bal('ETH', { eqUsd: '500', spotUplRatio: '-0.99' }),
    bal('BTC', { eqUsd: '500', spotUplRatio: '-0.01' }),
  ];
  const instruments = [
    { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
    { instId: 'BTC-USDT', quoteCcy: 'USDT', state: 'live', minSz: '1', lotSz: '0.00000001' },
  ];
  const okx = fakeExchange({
    balances, instruments, prices: { 'ETH-USDT': '1767.30', 'BTC-USDT': '84000.0' },
  });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(ctx.notified, []);
});

test('a plan whose budget cannot be read skips with that reason, not as OKX unreadable', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const { ts, v, halted, ...line } = planOf(ctx);
  ctx.store.appendLedger({ ...line, budget: 'ten' }, T0 - HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.equal(last.reason, 'the plan on record cannot be read (its budget). Make a new plan.');
  assert.equal(places(okx).length, 0);
});

async function openThenFilled(level) {
  let state = 'live';
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? (state === 'live' ? LIVE_ROW : null) : notFound()) });
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: level });
  await buyVerb(ctx, { profile: 't' });
  const n = ctx.notified.length;
  state = 'filled';
  ctx.setNow(T0 + HOUR);
  await buyVerb(ctx, { profile: 't' });
  return { ctx, n };
}

test('a later run that fills an open order notifies it at info', async () => {
  const quiet = await openThenFilled('problems');
  assert.match(quiet.ctx.notified.at(-1), /ETH-USDT: the order is still open on OKX\. The next run reads it again\./);
  assert.equal(quiet.ctx.notified.length, quiet.n);
  assert.equal(kinds(quiet.ctx).at(-1), 'buy_filled');
  const all = await openThenFilled('all');
  assert.equal(all.ctx.notified.length, all.n + 1);
  assert.equal(all.ctx.notified.at(-1), 'AvgKeeper read back earlier orders: ETH-USDT for 2026-10-05: filled.');
});

test('a run that died after a send gets its period_done and a notice from the next run', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, { only: 'ETH' });
  const clOrdId = idFor(ctx, 'ETH-USDT');
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planOf(ctx).id, period: '2026-10-05', instId: 'ETH-USDT', clOrdId, amount: '10.00', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  okx.orders.set(clOrdId, { instId: 'ETH-USDT', sz: '10.00' });
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(kinds(ctx).slice(-2), ['buy_filled', 'period_done']);
  assert.equal(ctx.notified.at(-1), 'AvgKeeper read back earlier orders: ETH-USDT for 2026-10-05: filled. The run for 2026-10-05 stopped partway; it had recorded these orders: ETH-USDT.');
  assert.equal(places(okx).length, 0);
});

// Review findings (buy.mjs:231, buy.mjs:256): a run that sent and settled its very last coin, then died before it
// ever wrote the next coin's own buy_sent, leaves no unsettled send at all: nothing pointed resolveOpen at that
// period before. The next run must still close it and say so, from stalePeriods (planview.mjs) alone.
test('a run that filled its last coin and died before the next coin ever sent gets closed by the next run', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const planId0 = planOf(ctx).id;
  const ethId = idFor(ctx, 'ETH-USDT');
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '6.67', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '6.67', profile: 't', env: 'live', notional: 6.67, accFillSz: '0.00377', avgPx: '1767.30',
  }, T0);
  assert.deepEqual(kinds(ctx).slice(-2), ['buy_sent', 'buy_filled']);
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(kinds(ctx).at(-1), 'period_done');
  // New regression (buy.mjs:316): this run read nothing back at all (BTC's own send was never even recorded), so
  // the notice must not open with "read back earlier orders".
  assert.equal(ctx.notified.at(-1), 'AvgKeeper closed an earlier period: The run for 2026-10-05 stopped partway; it had recorded these orders: ETH-USDT.');
  assert.equal(places(okx).length, 0, 'BTC is never sent by this catch-up; it only closes the period');
});

// Review finding (buy.mjs:262): buy_sent is written before the send itself, so naming every buy_sent coin "sent"
// overclaims for one OKX later confirms it never received (the 2-hour not-found settlement). That coin is excluded
// from the closed-period's own "recorded" sentence, even though it is still named by its own rejection line.
test('the stopped-partway sentence never names a coin OKX later confirmed it never received', async () => {
  const ctx = await withPlan(fakeExchange(LOSING), {}, { notify: 'cat', notifyLevel: 'all' });
  const planId0 = planOf(ctx).id;
  const ethId = idFor(ctx, 'ETH-USDT');
  const btcId = idFor(ctx, 'BTC-USDT');
  for (const [instId, clOrdId] of [['ETH-USDT', ethId], ['BTC-USDT', btcId]]) {
    ctx.store.appendLedger({
      kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId, clOrdId, amount: '5.00', lossPct: 5, profile: 't', env: 'live',
    }, T0);
  }
  // ETH's send actually reached OKX and filled; BTC's own spot place never ran at all (probe P8).
  ctx.okx.orders.set(ethId, { instId: 'ETH-USDT', sz: '5.00' });
  ctx.setNow(T0 + NOT_FOUND_SETTLE_MS);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.ok(kinds(ctx).includes('buy_filled'));
  assert.ok(kinds(ctx).includes('buy_rejected'));
  const notice = ctx.notified.at(-1);
  assert.match(notice, /The run for 2026-10-05 stopped partway; it had recorded these orders: ETH-USDT\./, notice);
  assert.doesNotMatch(notice, /stopped partway;[^.]*BTC-USDT/, notice);
  assert.equal(places(ctx.okx).length, 0);
});

// Review finding (buy.mjs:213, later): halt()'s own filledSoFar read used to run with no guard, before plan_halted
// is ever written. halt() is built to always write plan_halted even when a ledger read fails (unsettledSends,
// right below it, already guards itself the same way): a crash or a bad line is not a reason to leave the plan
// active and free to send another order into an outcome nobody has read yet.
test('a ledger read failure inside halt() (this period\'s own fills) still leaves the plan halted', async () => {
  let ethId = null;
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id) => (id === ethId ? null : { state: 'weird_state', accFillSz: '0', avgPx: '' }),
  });
  const ctx = await withPlan(okx);
  ethId = idFor(ctx, 'ETH-USDT');
  const realAppend = ctx.store.appendLedger.bind(ctx.store);
  const realRead = ctx.store.readLedger.bind(ctx.store);
  let btcSent = false;
  let failedOnce = false;
  ctx.store.appendLedger = (entry, now) => {
    realAppend(entry, now);
    if (entry.kind === 'buy_sent' && entry.instId === 'BTC-USDT') btcSent = true;
  };
  ctx.store.readLedger = () => {
    if (btcSent && !failedOnce) {
      failedOnce = true;
      throw new Error('EIO (simulated)');
    }
    return realRead();
  };
  try {
    await buyVerb(ctx, { profile: 't' });
  } catch {
    // halt() must still have written plan_halted before whatever propagated out of this read failure.
  }
  assert.ok(failedOnce, 'the injected read failure actually ran');
  ctx.store.readLedger = realRead;
  const plan = activePlan(ctx.store.readLedger(), CALL);
  assert.ok(plan && plan.halted, 'the plan is still halted despite the read failure');
  assert.doesNotMatch(plan.halted, /Before it halted, this period bought/, plan.halted);
});

// Review finding (buy.mjs:365 area / manage.mjs stopLocked, should): halt() never writes period_done for its own
// halt period by design (its own halt notice already carries that period's fill details). closeStalePeriods had no
// way to tell a halt's own period apart from a genuinely stale one, so stop (or a same-id confirm) sent a second
// "closed an earlier period" notice repeating the very same fill details under a different notice id.
test('stop after a halt sends no second notice repeating the halt\'s own fill details', async () => {
  let ethId = null;
  const okx = fakeExchange({
    ...LOSING,
    // ETH: null falls through to the default reply, a normal fill. BTC: an undocumented state halts the plan.
    getReply: (id) => (id === ethId ? null : { state: 'weird_state', accFillSz: '0', avgPx: '' }),
  });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'all', command: 'cat' } });
  ethId = idFor(ctx, 'ETH-USDT');
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.ok(planOf(ctx).halted, 'the plan halted');
  assert.equal(ctx.mailed.length, 1, 'the halt itself mails once, with ETH\'s own fill detail');
  assert.match(ctx.mailed[0].body, /ETH-USDT/);
  ctx.env = OWNER;
  ctx.setNow(T0 + HOUR);
  ctx.lines.length = 0;
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.doesNotMatch(text(ctx), /closed an earlier period/, text(ctx));
  assert.equal(ctx.mailed.length, 1, 'stop must not send a second mail repeating the halt\'s own fill details');
});

// Review finding (buy.mjs:316, should): resolveOpen gathered a stale period's own already-filled clOrdIds into
// the mail's own `filled` list only "when the read-back loop did not touch that period" at all. A period this run
// DOES touch (because one of its other coins is still unsettled) never runs that gathering step, so a coin the
// dead run already filled before it crashed reaches no mail detail line, even though the plain "recorded these
// orders" sentence still names it.
test('a coin the dead run already filled still gets its own mail detail line when another coin needs reading back too', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { mail: { to: 'a@b.co', level: 'all', command: 'cat' } });
  const planId0 = planOf(ctx).id;
  const ethId = idFor(ctx, 'ETH-USDT');
  const btcId = idFor(ctx, 'BTC-USDT');
  // Run 1 (simulated dying mid read-back): ETH was sent and filled, then BTC was sent, then the run died.
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '6.67', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '6.67', profile: 't', env: 'live', notional: 6.67, accFillSz: '0.00377', avgPx: '1767.30',
  }, T0);
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'BTC-USDT', clOrdId: btcId, amount: '3.33', lossPct: 5, profile: 't', env: 'live',
  }, T0);
  ctx.okx.orders.set(btcId, { instId: 'BTC-USDT', sz: '3.33' }); // BTC lands and reads back as filled this run
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const notice = ctx.store.readLedger().filter((e) => e.kind === 'notice').at(-1);
  assert.match(notice.body, /it had recorded these orders: ETH-USDT, BTC-USDT\./, notice.body);
  assert.match(notice.body, /ETH-USDT: share 6\.67 USDT/, notice.body);
  assert.match(notice.body, /BTC-USDT: share 3\.33 USDT/, notice.body);
});

// Section 10: an hourly plan buys once per hour, in each of two consecutive hours, never twice within one hour.
test('an hourly plan buys each due hour once: twice across two consecutive hours, once within one hour', async () => {
  const okx = fakeExchange(LOSING);
  const hourlyFlags = {
    profile: 't', budget: '10', every: 'hour', method: 'weighted', at: ':00',
  };
  const ctx = makeCtx({
    env: OWNER,
    okx,
    now: T0 - 2 * HOUR,
    config: {
      notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'all', command: 'cat' },
    },
  });
  await planVerb(ctx, hourlyFlags);
  await planVerb(ctx, { ...hourlyFlags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 2);
  assert.match(ctx.notified.at(-1), /AvgKeeper bought 2026-10-05 10: ETH [\d.]+ USDT, BTC [\d.]+ USDT/);
  assert.match(ledgerOf(ctx).find((e) => e.kind === 'notice' && e.id.endsWith(':buy')).subject, /\(2026-10-05 10\)$/);

  // Later in the same hour: already bought, nothing new is read from OKX.
  const before = okx.calls.length;
  ctx.setNow(T0 + 30 * 60000);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(okx.calls.length, before);
  assert.equal(places(okx).length, 2);

  // The next hour: due again, and buys again.
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 4);
  const periods = [...new Set(ledgerOf(ctx).filter((e) => e.kind === 'buy_sent').map((e) => e.period))];
  assert.deepEqual(periods, ['2026-10-05 10', '2026-10-05 11']);
});

test('a plan that replaces one which already bought today does not buy again today', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  await buyVerb(ctx, { profile: 't' });
  const n = places(okx).length;
  ctx.env = OWNER;
  ctx.setNow(T0 + 30 * 60000);
  const later = { ...flags, at: '11:00' };
  await planVerb(ctx, later);
  assert.equal(await planVerb(ctx, { ...later, confirm: 'AVGPLAN' }), 0);
  ctx.env = SCHEDULED;
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, n);
  ctx.setNow(T0 + DAY + HOUR);
  await buyVerb(ctx, { profile: 't' });
  assert.ok(places(okx).length > n);
});

// Item 1 of the 2026-09-26 review: a held lock that is old is named, with its time and the file to delete.
test('a stale lock held by a live process is not taken over, and the run says how old it is and what to delete', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  // Mid-minute, so the minute the sentence names cannot tip over between the write and the read.
  const oldMs = Math.floor((Date.now() - 20 * 60000) / 60000) * 60000 + 30000;
  fs.utimesSync(f, oldMs / 1000, oldMs / 1000);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.equal(places(okx).length, 0);
  const sentence = `AvgKeeper could not buy: a lock from ${isoMinute(fs.statSync(f).mtimeMs)} (another AvgKeeper run, or one that crashed) is still held. If no AvgKeeper run is working, delete ${ctx.store.home}/buy-t-live.lock.`;
  assert.ok(ctx.lines.includes(sentence), text(ctx));
  assert.equal(ctx.notified.at(-1), sentence);
});

test('a young held lock says only that another run holds it, and notifies nothing', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const release = ctx.store.lock('buy-t-live');
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  release();
  assert.match(text(ctx), /Another AvgKeeper run holds the buy lock for this profile\. This run bought nothing\./);
  assert.doesNotMatch(text(ctx), /is working on this profile|could not buy/);
  assert.deepEqual(ctx.notified, []);
});

// Item 1: an empty lock file left by a crash between create and write stopped every buy forever.
test('a 20-minute-old empty buy lock is taken over by buy (takeover false) and the buy goes through', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, '');
  const old = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(f, old, old);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 2);
  assert.ok(!fs.existsSync(f));
});

// Review finding (buy.mjs:64, later): SKILL.md lists the dry run as a READ that "Sends nothing", but an ledger
// ctx.store.readLedger() cannot read AT ALL (two bad lines, not just one tolerated torn line) reached tell()
// unguarded by `if (!dry)`, unlike the torn-ledger and newer-schema branches right below it.
test('a dry run over a ledger that cannot be read at all notifies and mails nothing', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  fs.writeFileSync(path.join(ctx.store.home, 'ledger.jsonl'), 'garbage1\ngarbage2\n');
  ctx.env = OWNER;
  assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 1);
  assert.match(text(ctx), /AvgKeeper could not read its own records, so it bought nothing:/);
  assert.deepEqual(ctx.notified, []);
});

// Item 6: a torn line can be the plan_halted or plan_stopped that ends a plan; reading past it would buy again.
test('a torn ledger line stops the buy: nothing written, the warning printed and notified, exit 1', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const file = path.join(ctx.store.home, 'ledger.jsonl');
  fs.appendFileSync(file, '{"kind":"plan_halted","planId":\n');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(places(okx).length, 0);
  assert.match(text(ctx), /WARNING: line \d+ of/);
  assert.ok(text(ctx).includes(`${ctx.store.home}/ledger.jsonl could not be read and was skipped`), text(ctx));
  assert.match(ctx.notified.at(-1), /AvgKeeper bought nothing: WARNING: line \d+ of/);
});

// Item 2 of the 2026-09-26 review: a ledger a newer AvgKeeper copy already wrote to (a raw v2 line) refuses the
// buy right after the torn-line check, before OKX is ever touched, and writes nothing.
test('a ledger with a newer schema line refuses the buy, notifies and calls OKX not at all', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  const file = path.join(ctx.store.home, 'ledger.jsonl');
  fs.appendFileSync(file, '{"kind":"plan_card","v":2}\n');
  const before = fs.readFileSync(file, 'utf8');
  okx.calls.length = 0;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(okx.calls.length, 0);
  assert.ok(text(ctx).includes(`REFUSED: a newer AvgKeeper already wrote to ${ctx.store.home}, so this copy buys nothing. Update this copy of the skill.`), text(ctx));
  assert.match(ctx.notified.at(-1), /AvgKeeper bought nothing: REFUSED: a newer AvgKeeper already wrote/);
});

// Item 3a: a send still waiting keeps the next period from buying at all.
test('a send still waiting from an earlier day skips the new period with its id, and sends nothing', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? LIVE_ROW : notFound()) });
  const ctx = await withPlan(okx, { only: 'ETH' }, { notify: 'cat', notifyLevel: 'problems' });
  await buyVerb(ctx, { profile: 't' });
  const id = idFor(ctx, 'ETH-USDT');
  assert.equal(places(okx).length, 1);
  ctx.setNow(T0 + DAY);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(okx).length, 1);
  const last = ledgerOf(ctx).at(-1);
  assert.equal(last.kind, 'period_skipped');
  assert.equal(last.period, '2026-10-06');
  assert.equal(last.reason, `an earlier order's result is not known yet (${id}); the next run reads it again.`);
  assert.match(ctx.notified.at(-1), /AvgKeeper skipped 2026-10-06: an earlier order's result is not known yet/);
});

// Item 3b: after one coin's result is 'wait', the coins after it are not sent this period.
test('after a wait on the first coin, the remaining coins are not sent and are named in the notice', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? LIVE_ROW : notFound()) });
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['ETH-USDT', '6.67']]);
  assert.deepEqual(kinds(ctx).slice(-2), ['buy_sent', 'period_done']);
  assert.match(ctx.notified.at(-1), /Not sent, because an earlier order's result is not known yet: BTC-USDT\./);
});

// Item 4: the schedule fires at machine time; a plan from another time zone is named on every run.
test('a Mac on another time zone than the plan is warned on buy, and due is still decided by the plan', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'problems' });
  ctx.timeZone = 'America/New_York';
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const w = 'WARNING: this plan was made in Europe/Istanbul, but this Mac is now on America/New_York. The schedule fires at machine time, so make a new plan with AVGPLAN, which reinstalls the schedule.';
  assert.ok(ctx.lines.includes(`AvgKeeper: ${w}`), 'the screen shows the same line the notify command gets');
  assert.equal(ctx.notified[0], `AvgKeeper: ${w}`);
  assert.equal(places(okx).length, 2);
});

// Item 8: the rejected-buy line keeps OKX's first sentence only, and 54092 gets its own plain sentence.
test('a long OKX rejection keeps its first sentence, cut to 120 characters; 54092 names the disclaimer', async () => {
  const long = `${'x'.repeat(200)}. Second sentence that must not appear.`;
  const okx = fakeExchange({
    ...LOSING,
    placeReply: (args) => (args[3] === 'ETH-USDT'
      ? [{ sCode: '54092', sMsg: 'Please accept the disclaimer. You must go to the website and '.padEnd(300, 'y') }]
      : [{ sCode: '51000', sMsg: long }]),
  });
  const ctx = await withPlan(okx);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const n = ctx.notified.at(-1);
  assert.ok(n.includes('ETH-USDT: OKX requires you to accept a disclaimer for this pair on the OKX website before it can be bought by API. Nothing spent on it.'), n);
  assert.ok(n.includes(`BTC-USDT: OKX rejected the buy (${'x'.repeat(120)}). Nothing spent on it.`), n);
  assert.doesNotMatch(n, /Second sentence|Please accept|yyyy/);
  assert.equal(rejectedLine('A-USDT', { sCode: '51001', sMsg: 'Instrument ID does not exist: A-USDT' }), 'A-USDT: OKX rejected the buy (Instrument ID does not exist). Nothing spent on it.');
});

// Review finding (buy.mjs:418, later): cutting at the first ". " or ": " lost the real cause whenever sMsg opened
// with a generic clause of its own. GridKeeper's own fixture (runner.test.mjs:321) records 51008 as exactly this
// shape: "Order failed. Insufficient balance".
test('rejectedLine keeps the real cause behind a generic "Order failed." clause', () => {
  assert.equal(
    rejectedLine('ETH-USDT', { sCode: '51008', sMsg: 'Order failed. Insufficient balance' }),
    'ETH-USDT: OKX rejected the buy (Insufficient balance). Nothing spent on it.',
  );
});

// Review finding (buy.mjs:480, later): GENERIC_LEAD accepts "Order failed" with no dot at all, but its own \s*
// never matches the ": " that follows in that shape, so the cut left a leading ": " in place. The very next split
// on /\. |: / then matched right at the string's own start, giving an empty first part and falling back to the
// bare sCode: the exact loss this fix was meant to close, just one punctuation mark later.
test('rejectedLine keeps the real cause behind a generic "Order failed:" clause with no dot', () => {
  assert.equal(
    rejectedLine('ETH-USDT', { sCode: '51008', sMsg: 'Order failed: Insufficient USDT balance' }),
    'ETH-USDT: OKX rejected the buy (Insufficient USDT balance). Nothing spent on it.',
  );
});

test('free USDT just under the budget is never rounded up to it; an exact balance buys', async () => {
  for (const availBal of ['9.995', '9.996', '9.999']) {
    const okx = fakeExchange({ ...LOSING, balances: [bal('USDT', { availBal, spotUplRatio: '' }), ...LOSING.balances.slice(1)] });
    const ctx = await withPlan(okx);
    await buyVerb(ctx, { profile: 't' });
    assert.equal(places(okx).length, 0, availBal);
    assert.equal(ledgerOf(ctx).at(-1).kind, 'period_skipped', availBal);
  }
  // 2.01 * 100 is 200.99999999999997 as a float, so a floored x * 100 would skip a balance that covers the budget.
  const okx = fakeExchange({ ...LOSING, balances: [bal('USDT', { availBal: '2.01', spotUplRatio: '' }), ...LOSING.balances.slice(1)] });
  const ctx = await withPlan(okx, { budget: '2.01', only: 'ETH' });
  await buyVerb(ctx, { profile: 't' });
  assert.deepEqual(sizes(okx), [['ETH-USDT', '2.01']]);
});

// Mutant (a): the pre-send read-back skipped.
test('an order found before the send is recorded as filled and never sent again', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx);
  okx.orders.set(idFor(ctx, 'ETH-USDT'), { instId: 'ETH-USDT', sz: '6.67' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['BTC-USDT', '3.33']]);
  const eth = ledgerOf(ctx).filter((e) => e.instId === 'ETH-USDT');
  assert.deepEqual(eth.map((e) => e.kind), ['buy_sent', 'buy_filled']);
  assert.equal(eth[0].found, true);
});

// Mutant (b): READ_BACK_TRIES set to 1.
test('an order live on the first read-back and filled on the second is recorded in the same run', async () => {
  const reads = new Map();
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => {
      if (!o) return notFound();
      reads.set(id, (reads.get(id) || 0) + 1);
      return reads.get(id) === 1 ? LIVE_ROW : null;
    },
  });
  const ctx = await withPlan(okx, { only: 'ETH' });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(kinds(ctx).slice(-3), ['buy_sent', 'buy_filled', 'period_done']);
});

// Mutant (d): resolveOpen ignoring 'halt'.
// Since item 3b a run leaves at most one coin waiting, so the two open sends are a run that died after both sends.
test('a later run halts on the first unreadable open order and never reads the second', async () => {
  let ethId = null;
  const reads = [];
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => {
      if (!o) return notFound();
      reads.push(id);
      return id === ethId ? { state: 'filled', accFillSz: '', avgPx: '' } : null;
    },
  });
  const ctx = await withPlan(okx);
  ethId = idFor(ctx, 'ETH-USDT');
  const btcId = idFor(ctx, 'BTC-USDT');
  for (const [instId, clOrdId] of [['ETH-USDT', ethId], ['BTC-USDT', btcId]]) {
    ctx.store.appendLedger({
      kind: 'buy_sent', planId: planOf(ctx).id, period: '2026-10-05', instId, clOrdId, amount: '5.00', lossPct: 5, profile: 't', env: 'live',
    }, T0);
    okx.orders.set(clOrdId, { instId, sz: '5.00' });
  }
  assert.equal(openOf(ctx).length, 2);
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  assert.deepEqual(reads, [ethId]);
  assert.ok(planOf(ctx).halted.includes(`Check order(s) in the OKX app: ${orderName('BTC-USDT', '5.00', '2026-10-05', btcId)}.`));
  assert.deepEqual(openOf(ctx), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Mail notices (spec section 9). mail.test.mjs covers the pure pieces and tell()'s own contract in isolation;
// these run the whole buy path so the wiring itself is proven, not only the function it calls.
// ---------------------------------------------------------------------------------------------------------------

const MAIL_ALL = { notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'all', command: 'cat' } };

test('a finished buy prepares a mail notice whose first line is the run own printed summary, with per-order details after it', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, MAIL_ALL);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const summary = ctx.lines.at(-1);
  assert.match(summary, /^AvgKeeper bought 2026-10-05: ETH [\d.]+ USDT, BTC [\d.]+ USDT\.$/);
  const notice = ledgerOf(ctx).find((e) => e.kind === 'notice' && e.id === `${planOf(ctx).id}:2026-10-05:buy`);
  assert.ok(notice, ledgerOf(ctx).filter((e) => e.kind === 'notice').map((e) => e.id).join(','));
  assert.equal(notice.severity, 'info');
  assert.equal(notice.body.split('\n')[0], summary, 'the mail carries the run own line unchanged, never a second telling of it');
  assert.match(notice.body, /ETH-USDT: share 6\.67 USDT, loss 10\.00% at buy time, filled [\d.]+ at 1767\.30 USDT, notional [\d.]+ USDT\./);
  assert.match(notice.body, /BTC-USDT: share 3\.33 USDT, loss 5\.00% at buy time, filled [\d.]+ at 84000(\.0+)? USDT, notional [\d.]+ USDT\./);
  assert.equal(notice.body.split('\n').at(-1), `AvgKeeper notice id: ${notice.id}`);
  assert.ok(notice.body.split('\n').includes(planLine(planOf(ctx))), 'spec section 9: the body carries the plan line');
  assert.match(notice.subject, /^\[AvgKeeper \/ t live\] bought [\d.]+ USDT across 2 coins \(2026-10-05\)$/);
  assert.equal(ledgerOf(ctx).filter((e) => e.kind === 'notice_sent' && e.id === notice.id).length, 1);
  assert.equal(ctx.mailed.length, 1);
});

test('a skipped period prepares a mail notice of kind skip, whose body starts with the run own printed line', async () => {
  const okx = fakeExchange({ ...LOSING, balances: [bal('USDT', { availBal: '9.99', spotUplRatio: '' }), ...LOSING.balances.slice(1)] });
  const ctx = await withPlan(okx, {}, MAIL_ALL);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const summary = ctx.lines.at(-1);
  assert.match(summary, /^AvgKeeper skipped 2026-10-05: free USDT 9\.99, below the 10\.00 USDT this buy needs\.$/);
  const notice = ledgerOf(ctx).find((e) => e.kind === 'notice' && e.id === `${planOf(ctx).id}:2026-10-05:skip`);
  assert.ok(notice);
  assert.equal(notice.body.split('\n')[0], summary);
  assert.ok(notice.body.split('\n').includes(planLine(planOf(ctx))), 'spec section 9: the body carries the plan line');
  assert.match(notice.subject, /^\[AvgKeeper \/ t live\] skipped 2026-10-05: free USDT 9\.99/);
});

test('a halted plan prepares a mail notice of kind halt, whose body starts with the run own printed line', async () => {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? { state: 'filled', fillSz: '', avgPx: '' } : notFound()) });
  const ctx = await withPlan(okx, {}, MAIL_ALL);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  const summary = ctx.lines.at(-1);
  assert.match(summary, /^AvgKeeper HALTED: /);
  const notice = ledgerOf(ctx).find((e) => e.kind === 'notice' && e.id === `${planOf(ctx).id}:2026-10-05:halt`);
  assert.ok(notice, ledgerOf(ctx).filter((e) => e.kind === 'notice').map((e) => e.id).join(','));
  assert.equal(notice.body.split('\n')[0], summary);
  assert.ok(notice.body.split('\n').includes(planLine(planOf(ctx))), 'spec section 9: the body carries the plan line');
  assert.match(notice.subject, /^\[AvgKeeper \/ t live\] HALTED:/);
});

const MAIL_PROBLEMS = { mail: { to: 'a@b.co', level: 'problems' } };
const noticeIds = (ctx) => ledgerOf(ctx).filter((e) => e.kind === 'notice').map((e) => e.id);
const noticeOf = (ctx, id) => ledgerOf(ctx).find((e) => e.kind === 'notice' && e.id === id);
const lowUsdt = () => fakeExchange({ ...LOSING, balances: [bal('USDT', { availBal: '8.20', spotUplRatio: '' }), ...LOSING.balances.slice(1)] });

// A period-less warning has its own kind word, so it can never take the id of a real skip on the same day.
test('a time zone warning and a real skip on the same day are two notices, not one id', async () => {
  const ctx = await withPlan(lowUsdt(), {}, MAIL_PROBLEMS);
  ctx.timeZone = 'Europe/Berlin';
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const id = planOf(ctx).id;
  assert.deepEqual(noticeIds(ctx), [`${id}:2026-10-05:tz`, `${id}:2026-10-05:skip`]);
  assert.match(noticeOf(ctx, `${id}:2026-10-05:skip`).body, /^AvgKeeper skipped 2026-10-05: free USDT 8\.20/);
});

test('a stale lock notice and a later skip of the same period are two notices, not one id', async () => {
  const ctx = await withPlan(lowUsdt(), {}, MAIL_PROBLEMS);
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  const old = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(f, old, old);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  fs.rmSync(f);
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const id = planOf(ctx).id;
  assert.deepEqual(noticeIds(ctx), [`${id}:2026-10-05:lock`, `${id}:2026-10-05:skip`]);
});

// Research doc rule 2: the mail's first line is the line the run printed, on every path, not a second wording.
test('the time zone and torn-ledger notices start with the exact line the run printed', async () => {
  const tz = await withPlan(fakeExchange(LOSING), {}, MAIL_PROBLEMS);
  tz.timeZone = 'America/New_York';
  await buyVerb(tz, { profile: 't' });
  const tzNotice = ledgerOf(tz).find((e) => e.kind === 'notice' && e.id.endsWith(':tz'));
  assert.ok(tz.lines.includes(tzNotice.body.split('\n')[0]), `${tzNotice.body}\n---\n${text(tz)}`);

  const torn = await withPlan(fakeExchange(LOSING), {}, MAIL_PROBLEMS);
  fs.appendFileSync(path.join(torn.store.home, 'ledger.jsonl'), '{"kind":"plan_halted","planId":\n');
  assert.equal(await buyVerb(torn, { profile: 't' }), 1);
  const tornNotice = ledgerOf(torn).find((e) => e.kind === 'notice');
  assert.ok(torn.lines.includes(tornNotice.body.split('\n')[0]), `${tornNotice.body}\n---\n${text(torn)}`);
});

// Money spent before a halt reaches a mail with its details, not only the order that halted.
test('a halt after one coin filled carries that fill in the halt notice details', async () => {
  const okx = fakeExchange({
    ...LOSING,
    getReply: (id, o) => {
      if (!o) return notFound();
      if (o.instId === 'BTC-USDT') return { state: 'filled', accFillSz: '', avgPx: '' };
      return null;
    },
  });
  const ctx = await withPlan(okx, {}, MAIL_ALL);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 1);
  const notice = noticeOf(ctx, `${planOf(ctx).id}:2026-10-05:halt`);
  assert.ok(notice, noticeIds(ctx).join(','));
  assert.match(notice.body, /^ {2}ETH-USDT: share 6\.67 USDT, loss 10\.00% at buy time, filled [\d.]+ at 1767\.30 USDT, notional 6\.67 USDT\.$/m);
});

test('a later run that fills an open order mails the fill details with the read-back notice', async () => {
  let state = 'live';
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? (state === 'live' ? LIVE_ROW : null) : notFound()) });
  const ctx = await withPlan(okx, { only: 'ETH' }, MAIL_ALL);
  await buyVerb(ctx, { profile: 't' });
  state = 'filled';
  ctx.setNow(T0 + HOUR);
  await buyVerb(ctx, { profile: 't' });
  const notice = noticeOf(ctx, `${planOf(ctx).id}:2026-10-05:resolve`);
  assert.ok(notice, noticeIds(ctx).join(','));
  assert.equal(notice.body.split('\n')[0], 'AvgKeeper read back earlier orders: ETH-USDT for 2026-10-05: filled.');
  assert.match(notice.body, /^ {2}ETH-USDT: share 10\.00 USDT, loss 10\.00% at buy time, filled [\d.]+ at 1767\.30 USDT, notional 10\.00 USDT\.$/m);
});

// Finding 18 remaining: a stale period closed by resolveOpen (buy.mjs:256) with no read-back at all still holds
// real money spent (its own buy_filled), but resolveOpen passed clOrdIds: filled, a list that only ever held sends
// THIS run itself settled. A stale period's fills were settled by the run that died, so buyOrderLines got an empty
// list and prepareMail added no detail line at all (spec section 9: money spent reaches a mail with its details on
// every path). Probe: appendLedger throws on BTC's buy_sent, right after ETH's buy_filled, so the next run closes
// the period with nothing left to read back.
test('a stale period closed with no read-back still mails the fill it holds', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, MAIL_ALL);
  const realAppend = ctx.store.appendLedger.bind(ctx.store);
  let count = 0;
  ctx.store.appendLedger = (entry, now) => {
    count += 1;
    if (count > 2) throw new Error('ENOSPC (simulated)');
    realAppend(entry, now);
  };
  await assert.rejects(buyVerb(ctx, { profile: 't' }));
  ctx.store.appendLedger = realAppend;
  ctx.setNow(T0 + HOUR);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const notice = noticeOf(ctx, `${planOf(ctx).id}:2026-10-05:resolve`);
  assert.ok(notice, noticeIds(ctx).join(','));
  assert.match(notice.body, /^ {2}ETH-USDT: share 6\.67 USDT, loss 10\.00% at buy time, filled [\d.]+ at 1767\.30 USDT, notional 6\.67 USDT\.$/m, notice.body);
});

// The period an event belongs to is the send's own period, not the day the run happens to read it back on.
async function openFromYesterday(reply) {
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? reply : notFound()) });
  const ctx = await withPlan(okx, { only: 'ETH' }, MAIL_ALL);
  const clOrdId = idFor(ctx, 'ETH-USDT', '2026-10-04');
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planOf(ctx).id, period: '2026-10-04', instId: 'ETH-USDT', clOrdId, amount: '10.00', lossPct: 10, profile: 't', env: 'live',
  }, T0 - 3 * HOUR);
  okx.orders.set(clOrdId, { instId: 'ETH-USDT', sz: '10.00' });
  ctx.setNow(T0 + HOUR);
  const code = await buyVerb(ctx, { profile: 't' });
  return { ctx, code };
}

test('a halt on an order sent for an earlier period is filed under that period, not today', async () => {
  const { ctx, code } = await openFromYesterday({ state: 'filled', accFillSz: '', avgPx: '' });
  assert.equal(code, 1);
  assert.ok(noticeIds(ctx).includes(`${planOf(ctx).id}:2026-10-04:halt`), noticeIds(ctx).join(','));
});

test('a read-back of an order sent for an earlier period is filed under that period, not today', async () => {
  const { ctx } = await openFromYesterday(null);
  assert.ok(noticeIds(ctx).includes(`${planOf(ctx).id}:2026-10-04:resolve`), noticeIds(ctx).join(','));
});

test('a mail command failure never changes what buy did: same orders, same ledger money lines, same exit code, only a WARNING added', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, MAIL_ALL);
  ctx.mailFails = new Error('mail command exited 1');
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['ETH-USDT', '6.67'], ['BTC-USDT', '3.33']]);
  assert.equal(kinds(ctx).filter((k) => k === 'buy_filled').length, 2);
  assert.match(text(ctx), /WARNING: your mail command failed: mail command exited 1/);
  assert.equal(ledgerOf(ctx).filter((e) => e.kind === 'notice_sent').length, 0, 'the notice stays pending, lane 1 having failed');
  assert.ok(ledgerOf(ctx).some((e) => e.kind === 'notice'), 'the notice itself was still written before lane 1 was attempted');
});

test('mail on with no address never disturbs a real buy, and says so once, not once per coin', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'all', mail: { level: 'all' } });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(sizes(okx), [['ETH-USDT', '6.67'], ['BTC-USDT', '3.33']]);
  assert.equal(ledgerOf(ctx).filter((e) => e.kind === 'notice').length, 0);
  assert.equal(ctx.lines.filter((l) => l.includes('no address is set')).length, 1, text(ctx));
});

test('mail off leaves buy exactly as it was before mail existed: nothing new in the ledger', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = await withPlan(okx, {}, { notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'off', command: 'cat' } });
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(kinds(ctx).slice(-5), ['buy_sent', 'buy_filled', 'buy_sent', 'buy_filled', 'period_done']);
  assert.equal(ctx.mailed.length, 0);
});
