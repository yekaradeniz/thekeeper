// avgkeeper/tests/settle-verdict.test.mjs
// settleVerdict (buy.mjs) is the one place both settle() (the real run) and previewSettle (the dry run) read the
// branch tree that decides what a read-back means (rule 3, one fact one reader). This is the agreement test: for
// every shape OKX can answer a still-unsettled send with, the dry run's own verdict on that send and what the real
// run actually does with it must say the same thing. Review finding, buy.mjs:538 (blocker): previewSettle used to
// keep its own copy of this tree and read fillOf's 'unreadable' kind as 'resolves' while settle() halts on it, so
// the dry run promised a split the real run then halted on. A table, not one test per shape, so a new row shape is
// one line to add, not a new test to remember to write.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCtx, fakeExchange, LOSING, SCHEDULED, OWNER, T0, HOUR, DAY, text, kinds, notFound,
} from './helpers.mjs';
import { OkxError } from '../scripts/runner.mjs';
import { buyVerb, NOT_FOUND_SETTLE_MS } from '../scripts/buy.mjs';
import { planVerb } from '../scripts/plan.mjs';
import { activePlan, unsettledSends } from '../scripts/planview.mjs';

const flags = {
  profile: 't', budget: '10', every: 'day', method: 'weighted', only: 'ETH',
};
const LIVE_ROW = { state: 'live', accFillSz: '0', avgPx: '' };
const ledgerOf = (ctx) => ctx.store.readLedger();
const planOf = (ctx) => activePlan(ledgerOf(ctx), { profile: 't', demo: false });

// A plan made at 08:00 Istanbul on 2026-10-05, with the clock then moved to 10:00, the buy time, exactly as
// buy.test.mjs's own withPlan does (not imported from there: each test file keeps its own small setup on top of
// the shared fakes in helpers.mjs).
async function withPlan(okx) {
  const ctx = makeCtx({
    env: OWNER, okx, now: T0 - 2 * HOUR, config: { notify: 'cat', notifyLevel: 'all' },
  });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  return ctx;
}

// Every shape settleVerdict branches on, in the order buy.mjs:210-onward checks them, each with the verdict both the
// dry run and the real run must agree on: 'halts' (settle() halts the plan), 'open' (still genuinely open or
// unreadable right now, the real run waits and buys nothing new this period) or 'resolves' (settle() turns it into
// money spent or a rejection and the send is no longer unsettled).
const ROWS = [
  { name: 'live (still on the book)', reply: () => LIVE_ROW, verdict: 'open' },
  { name: 'partially_filled (still on the book)', reply: () => ({ state: 'partially_filled', accFillSz: '0.0025', avgPx: '1767.30' }), verdict: 'open' },
  { name: 'filled with a readable fill', reply: () => ({ state: 'filled', accFillSz: '0.005', avgPx: '1767.30' }), verdict: 'resolves' },
  { name: 'filled with avgPx "" (unreadable)', reply: () => ({ state: 'filled', accFillSz: '0.005', avgPx: '' }), verdict: 'halts' },
  { name: 'filled with accFillSz missing (unreadable)', reply: () => ({ state: 'filled', avgPx: '1767.30' }), verdict: 'halts' },
  { name: 'canceled with nothing filled', reply: () => ({ state: 'canceled', accFillSz: '0', avgPx: '' }), verdict: 'resolves' },
  { name: 'no state at all', reply: () => ({ accFillSz: '0', avgPx: '' }), verdict: 'halts' },
  { name: 'an undocumented state', reply: () => ({ state: 'some_future_state', accFillSz: '0', avgPx: '' }), verdict: 'halts' },
  {
    name: 'notFound, younger than 2 hours', reply: () => notFound(), gapMs: HOUR, verdict: 'open',
  },
  {
    name: 'notFound, older than 2 hours', reply: () => notFound(), gapMs: NOT_FOUND_SETTLE_MS + 60000, verdict: 'resolves',
  },
  { name: 'a network read error', reply: () => new OkxError('Error: Failed to call OKX endpoint', 'network'), verdict: 'open' },
  { name: 'no row at all (an empty reply)', noRow: true, verdict: 'halts' },
];

for (const row of ROWS) {
  test(`dry run and real run agree on an unsettled send answered as: ${row.name}`, async () => {
    let phase = 'live';
    const okx = fakeExchange({
      ...LOSING,
      getReply: (id, o) => {
        if (!o) return notFound();
        return phase === 'live' ? LIVE_ROW : row.reply();
      },
    });
    if (row.noRow) {
      // fakeExchange's own getReply hook has no way to answer with no row at all (falsy just falls through to a
      // default reply); a direct override of the fake's json is the one way to make OKX answer nothing usable
      // (an empty data array), the same as readOrder's own 'empty reply' contract (orders.mjs) expects.
      const realJson = okx.json.bind(okx);
      okx.json = async (args, call) => {
        if (phase !== 'live' && args[0] === 'spot' && args[1] === 'get') {
          return { env: call.demo ? 'demo' : 'live', profile: call.profile || null, data: [] };
        }
        return realJson(args, call);
      };
    }
    const ctx = await withPlan(okx);
    assert.equal(await buyVerb(ctx, { profile: 't' }), 0, 'day 1 send'); // ETH stays live, unsettled
    phase = 'day2';
    ctx.env = OWNER;
    ctx.setNow(T0 + (row.gapMs ?? DAY));
    ctx.lines.length = 0;

    assert.equal(await buyVerb(ctx, { profile: 't', 'dry-run': true }), 0);
    const dryText = text(ctx);
    const dryVerdict = /would halt/.test(dryText) ? 'halts' : /is not known yet/.test(dryText) ? 'open' : 'resolves';
    assert.equal(dryVerdict, row.verdict, `dry run text for ${row.name}:\n${dryText}`);

    ctx.env = SCHEDULED;
    ctx.lines.length = 0;
    const code = await buyVerb(ctx, { profile: 't' });
    const ledger = ledgerOf(ctx);
    const stillOpen = unsettledSends(ledger, planOf(ctx).id);
    const ks = kinds(ctx);

    if (row.verdict === 'halts') {
      assert.equal(code, 1, `real run for ${row.name}: ${ks.join(',')}`);
      assert.ok(ks.includes('plan_halted'), `real run for ${row.name}: ${ks.join(',')}`);
    } else if (row.verdict === 'open') {
      assert.equal(code, 0, `real run for ${row.name}: ${ks.join(',')}`);
      assert.equal(stillOpen.length, 1, `real run for ${row.name} must still wait on the same send: ${ks.join(',')}`);
      assert.ok(!ks.includes('plan_halted'), `real run for ${row.name}: ${ks.join(',')}`);
    } else {
      assert.equal(code, 0, `real run for ${row.name}: ${ks.join(',')}`);
      assert.equal(stillOpen.length, 0, `real run for ${row.name} must have settled the send: ${ks.join(',')}`);
      assert.ok(ks.includes('buy_filled') || ks.includes('buy_rejected'), `real run for ${row.name}: ${ks.join(',')}`);
    }
  });
}
