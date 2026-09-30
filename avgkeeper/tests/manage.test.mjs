// avgkeeper/tests/manage.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  makeCtx, fakeExchange, LOSING, OWNER, SCHEDULED, CALL, T0, HOUR, DAY, text, kinds, bal, places,
} from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdingsVerb, statusVerb, stopVerb, notifyVerb } from '../scripts/manage.mjs';
import { planVerb } from '../scripts/plan.mjs';
import { buyVerb } from '../scripts/buy.mjs';
import { activePlan } from '../scripts/planview.mjs';
import { orderName, buyClOrdId } from '../scripts/orders.mjs';
import { commandText, shWord } from '../scripts/cmdtext.mjs';
import { launchdPlistPath, launchdRemoveLines } from '../scripts/schedule.mjs';
import { OkxError } from '../scripts/runner.mjs';
import { CONFIG_INIT_HINT } from '../scripts/guards.mjs';

const flags = { profile: 't', budget: '10', every: 'day', method: 'weighted' };

// Item 6 of the 2026-09-27 release audit: with no plan actually running, holdings says a plan WOULD buy a coin,
// never "in the plan", and names the next step.
test('holdings says a plan would buy a coin when no plan is running, and names the next step', async () => {
  const ctx = makeCtx({ okx: fakeExchange(LOSING) });
  assert.equal(await holdingsVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /ETH\s+208\.90 USDT\s+-10\.00%\s+a plan would buy it/);
  assert.match(t, /SOL\s+406\.24 USDT\s+19\.55%\s+out: in profit/);
  assert.match(t, /Free USDT: 1484\.90/);
  assert.ok(!t.includes('in the plan'), t);
  assert.match(t, /No plan is running yet on profile t \(live\); ask your agent for a plan card to start one\./);
});

// Review finding (manage.mjs:82): spec section 3 says holdings shows amount, OKX's own average cost, current
// value and profit or loss; the amount and the average cost were both missing from every row. eq's own raw string
// is shown at full precision (sigPrice), never a value OKX did not send.
test('holdings shows the amount held and OKX\'s average cost for each coin, "?" when OKX did not send one', async () => {
  const okx = fakeExchange({
    ...LOSING,
    balances: [
      LOSING.balances[0],
      bal('ETH', { eqUsd: '208.90', spotUplRatio: '-0.10', eq: '0.118158' }),
      bal('BTC', { eqUsd: '809.86', spotUplRatio: '-0.05', eq: '0.00964119', openAvgPx: '' }),
    ],
  });
  const ctx = makeCtx({ okx });
  assert.equal(await holdingsVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /ETH\s+208\.90 USDT\s+-10\.00%\s+a plan would buy it\s+\(amount 0\.118158, avg cost 100 USDT\)/);
  assert.match(t, /BTC\s+809\.86 USDT\s+-5\.00%\s+a plan would buy it\s+\(amount 0\.00964119, avg cost \? USDT\)/);
});

test('holdings says in the plan once a plan is actually running', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  assert.equal(await holdingsVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /ETH\s+208\.90 USDT\s+-10\.00%\s+in the plan/);
  assert.ok(!t.includes('a plan would buy it'), t);
  assert.ok(!t.includes('No plan is running yet'), t);
});

// Review finding (manage.mjs:81, rule 4): a halted plan buys nothing. holdings must say so, the same way status
// and doctor already do, and never call a halted plan's coins "in the plan" as if it would still buy them.
test('holdings names a halted plan and never calls its coins "in the plan"', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const plan = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'OKX did not accept API key t.' }, T0);
  ctx.lines.length = 0;
  assert.equal(await holdingsVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /HALTED: OKX did not accept API key t\./);
  assert.match(t, /ETH\s+208\.90 USDT\s+-10\.00%\s+in the halted plan \(not bought\)/);
  assert.ok(!/\bin the plan\b/.test(t), t);
});

// Item 5 of the 2026-09-27 release audit: a profile absent from the okx config is refused in plain words, before
// any account read, rather than surfacing later as a generic auth failure that reads as OKX rejecting a real key.
test('holdings refuses cleanly when the profile is not in the okx config', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = makeCtx({ okx });
  assert.equal(await holdingsVerb(ctx, { profile: 'ghost' }), 1);
  // Finding 14 of the 2026-09-27 release-readiness review: a REFUSED line is a finished answer (SKILL.md rule 6),
  // so this one names the next step, a step the user takes, never the agent.
  assert.equal(text(ctx), `REFUSED: profile ghost is not in the okx config. ${CONFIG_INIT_HINT}`);
  assert.ok(!okx.calls.some((c) => c.type === 'json' && c.args[0] === 'account'), 'the balance is never read for a profile that is not configured');
});

// Item 5: the profile IS in the okx config (so the check above passes), but the CLI's own auth helper cannot run
// for it: worded as a missing saved key, not a rejected one. Later item L6 of the 2026-09-27 release-readiness
// review: okx CLI 1.4.6 says "No credentials found." (dist/index.js, applyAuth) for a profile with no key saved
// once okx-auth is installed but not logged in, and that is the same missing key.
const noKeyOkx = (stderr) => {
  const okx = {
    calls: [],
    async json(args) {
      okx.calls.push(args);
      const key = args.slice(0, 2).join(' ');
      if (key === 'config show') return { env: 'live', profile: null, data: { profiles: { t: { site: 'global' } } } };
      if (key === 'account config' || key === 'account balance') throw new OkxError(stderr, 'auth', stderr);
      throw new Error(`unexpected call ${key}`);
    },
  };
  return okx;
};
for (const stderr of ['spawn okx-auth ENOENT', 'Error: No credentials found.\nHint: Run `okx auth login` to authenticate, or configure API key credentials.\nVersion: @okx_ai/okx-trade-cli@1.4.6\n']) {
  test(`holdings words a missing saved key as missing, not rejected: ${stderr.split('\n')[0]}`, async () => {
    const ctx = makeCtx({ okx: noKeyOkx(stderr) });
    assert.equal(await holdingsVerb(ctx, { profile: 't' }), 1);
    assert.equal(text(ctx), `REFUSED: the okx CLI has no key saved for profile t. ${CONFIG_INIT_HINT}`);
  });
}

// Findings 7 and 13 of the 2026-09-27 release-readiness review: the key guide sends a new user to holdings to check
// the connection and says it names a wrong permission instead of listing coins. holdings now reads the key's own
// permissions through the same reader and checks preflight uses, before any balance read.
test('holdings refuses a key that can withdraw or cannot trade, before listing any coin', async () => {
  for (const [perm, said] of [['read_only', 'API key t cannot trade.'], ['read_only,trade,withdraw', 'API key t can withdraw.']]) {
    const okx = fakeExchange({ ...LOSING, perm });
    const ctx = makeCtx({ okx });
    assert.equal(await holdingsVerb(ctx, { profile: 't' }), 1, perm);
    assert.ok(text(ctx).startsWith(`REFUSED: ${said}`), text(ctx));
    assert.doesNotMatch(text(ctx), /ETH|Free USDT/);
    assert.ok(!okx.calls.some((c) => c.type === 'json' && c.args.join(' ') === 'account balance'), 'no balance read for a key with the wrong permissions');
  }
});

test('status shows the plan, the last buys and skips', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  await buyVerb(ctx, { profile: 't' });
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /Running: 10\.00 USDT every day at 10:00/);
  assert.match(t, /2026-10-05 ETH-USDT 6\.67 USDT filled/);
  assert.match(t, /Last run: it bought, for 2026-10-05, on 2026-10-05 10:0\d \(Europe\/Istanbul\)\./);
  assert.doesNotMatch(t, /WARNING: \d+ due periods/);
});

// New regression: a plan id is a hash of its own settings alone (plan.mjs's planId), so a plan the user stops and
// remakes with identical settings gets the same id back. lastRunLine (period.mjs) used to key its "Last run" on
// planId alone, so status could credit the new plan with a buy the OLD, stopped incarnation made before this new
// one ever started. Recent stays account-wide (the test above already pins it to profile and mode, not to a plan):
// the owner still wants to see an earlier life's own buys there. Only "Last run" must never credit them to this life.
test('status never credits an earlier incarnation\'s own run as this plan\'s Last run, after a same-id restart', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const firstId = activePlan(ctx.store.readLedger(), CALL).id;
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  await buyVerb(ctx, { profile: 't' });
  ctx.env = OWNER;
  ctx.setNow(T0 + HOUR);
  await stopVerb(ctx, { profile: 't' });
  ctx.setNow(T0 + 2 * HOUR);
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const secondId = activePlan(ctx.store.readLedger(), CALL).id;
  assert.equal(secondId, firstId, 'identical settings hash to the same plan id');
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /2026-10-05 ETH-USDT 6\.67 USDT filled/, 'Recent still shows the earlier life\'s own buy');
  assert.doesNotMatch(t, /Last run: it bought, for 2026-10-05/, t);
  assert.match(t, /^Last run: never; the plan started 2026-10-05 12:00 \(Europe\/Istanbul\)\.$/m);
});

// Seen live on the owner's demo status, 2026-09-28: OKX's 50004 message ends in ". " ("API endpoint request
// timeout. "), the ledger kept it as it came, and status printed "result unknown: API endpoint request timeout. .
// Check it in the OKX app." A line already on disk keeps that text, so the display side trims it too.
test('status shows an unknown result recorded with OKX\'s trailing period without doubling it', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const plan = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({
    kind: 'buy_unknown', planId: plan.id, period: '2026-10-05', instId: 'APT-USDT', clOrdId: 'akx', amount: '0.31', profile: 't', env: 'live', error: 'API endpoint request timeout. ',
  }, T0);
  ctx.lines.length = 0;
  await statusVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /result unknown: API endpoint request timeout\. Check it in the OKX app\./, t);
  assert.doesNotMatch(t, /\. \./, t);
});

// Review finding (manage.mjs:130): no test pinned that status's Recent section is scoped to this profile and mode;
// every existing test's ledger held only one profile and one mode. A demo fill for the same profile, or a live
// fill for another profile, must never show up in `status --profile t` (live).
test('status\'s Recent section shows only this profile and mode, never a demo fill or another profile\'s', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  await buyVerb(ctx, { profile: 't' });
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: 'other', period: '2026-10-05', instId: 'DEMO-USDT', clOrdId: 'demofill', amount: '9.00', profile: 't', env: 'demo', notional: 9, accFillSz: '1', avgPx: '9',
  }, ctx.now());
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: 'other', period: '2026-10-05', instId: 'OTHER-USDT', clOrdId: 'otherprofile', amount: '9.00', profile: 'u', env: 'live', notional: 9, accFillSz: '1', avgPx: '9',
  }, ctx.now());
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /2026-10-05 ETH-USDT 6\.67 USDT filled/);
  assert.ok(!t.includes('DEMO-USDT'), t);
  assert.ok(!t.includes('OTHER-USDT'), t);
});

// Item 1 of the 2026-09-27 release audit: "Running" alone never says a schedule has stopped firing. A plan that
// was confirmed and never bought once reads "Last run: never" plus a WARNING naming every due day with no record.
// Review finding (notify.mjs:59, should): doctor already prints the config-problem line as a FAIL; status called
// mailStatus, which reads config through readConfigSafe too but silently discards its own `line`, so a user with
// mail set to all who breaks config.json by hand saw only "Mail: off." with no reason at all.
test('status prints the config problem, never a bare "Mail: off." with no reason', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), config: { mail: { to: 'a@b.co', level: 'all', command: 'cat' } } });
  fs.writeFileSync(path.join(ctx.store.home, 'config.json'), '{nope');
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /config\.json is not valid JSON .*notify and mail are both off until it is fixed\./);
  assert.match(t, /Mail: off\./);
});

test('status warns when the schedule looks dead: confirmed, then never once ran', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  ctx.setNow(T0 + 4 * DAY + 16 * 60000); // past the grace window (finding L4), not merely at the trigger minute
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /Last run: never; the plan started 2026-10-05 08:00 \(Europe\/Istanbul\)\./);
  assert.match(t, /WARNING: 5 due periods have no record since it started\. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time \(crontab skips those\), or the schedule line may be gone\. AvgKeeper cannot see your crontab or launchd; check that the line doctor prints is still in crontab -l, or that the launchd job is still loaded\./);
});

// Finding 12 remaining: a stale buy lock held by a live pid refuses every scheduled run before it ever writes a
// period line, the schedule firing every time regardless; status already prints its own stale-lock WARNING above
// this one and knows the fact, so the missing-periods line must name it too, not guess at the schedule.
test('status names the stale lock in its missing-periods warning, not a guess at the schedule', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const lockFile = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, start: 1 }));
  const past = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(lockFile, past, past);
  ctx.lines.length = 0;
  ctx.setNow(T0 + 4 * DAY + 16 * 60000);
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /The buy lock from .* is still held/);
  assert.match(t, /WARNING: 5 due periods have no record since it started: the buy lock has been held without being freed \(see the line above about the buy lock\), which refuses every buy while it is held\./);
  assert.doesNotMatch(t, /AvgKeeper cannot tell why/);
});

// Review finding (period.mjs:315): a stale lock whose pid is already dead refuses nothing (lock(name,
// {takeover:false}) takes it over at any age), so status must not blame missing periods on it. It also must not
// call it "still held" at all. The scheduled run right after takes the lock over and buys, proving the lock was
// never the reason nothing ran.
test('status never blames a dead-pid stale lock for missing periods, and the next scheduled run takes it over', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const lockFile = path.join(ctx.store.home, 'buy-t-live.lock');
  const deadPid = 2 ** 30;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, start: 1 }));
  const past = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(lockFile, past, past);
  ctx.lines.length = 0;
  ctx.setNow(T0 + 4 * DAY + 16 * 60000);
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.doesNotMatch(t, /still held/);
  assert.match(t, /WARNING: 5 due periods have no record since it started\. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time \(crontab skips those\), or the schedule line may be gone\. AvgKeeper cannot see your crontab or launchd; check that the line doctor prints is still in crontab -l, or that the launchd job is still loaded\./);
  ctx.env = SCHEDULED;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.match(text(ctx), /AvgKeeper bought 2026-10-09: ETH 6\.67 USDT, BTC 3\.33 USDT\./);
});

// Finding 4 of the 2026-09-27 release-readiness review: period_done is written even when nothing filled, so it alone
// never says "it bought". Every coin rejected by OKX: the summary says nothing was bought, and so does Last run.
test('status never says it bought when every coin of the last run was rejected', async () => {
  const okx = fakeExchange({ ...LOSING, placeReply: () => [{ sCode: '51008', sMsg: 'Insufficient balance' }] });
  const ctx = makeCtx({ env: OWNER, okx, now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.match(text(ctx), /AvgKeeper bought 2026-10-05: nothing\./);
  assert.equal(kinds(ctx).at(-1), 'period_done');
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /Last run: it finished with no fill recorded, for 2026-10-05, on 2026-10-05 10:0\d \(Europe\/Istanbul\)\./);
  assert.doesNotMatch(t, /it bought/);
});

// Review finding (manage.mjs:91, index 23): status's Recent section printed a rejection's raw sMsg, up to OKX's
// own 300-character disclaimer text in full. The buy summary already replaces that with rejectedLine's one
// sentence (buy.mjs); status must read the same fact the same way (rule 3, one fact one reader).
test('status names a rejected buy with rejectedLine\'s own sentence, never OKX\'s raw sMsg', async () => {
  const longMsg = 'You must accept the disclaimer for this trading pair on the OKX website before it can be traded through the API. '.repeat(3).slice(0, 300);
  const okx = fakeExchange({ ...LOSING, placeReply: (args) => (args[args.indexOf('--instId') + 1] === 'ETH-USDT' ? [{ sCode: '54092', sMsg: longMsg }] : null) });
  const ctx = makeCtx({ env: OWNER, okx, now: T0 - 2 * HOUR });
  await planVerb(ctx, { ...flags, only: 'ETH' });
  await planVerb(ctx, { ...flags, only: 'ETH', confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  await buyVerb(ctx, { profile: 't' });
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /2026-10-05 ETH-USDT: OKX requires you to accept a disclaimer for this pair on the OKX website before it can be bought by API\. Nothing spent on it\./);
  assert.ok(!t.includes(longMsg), t);
});

// A coin dropped below OKX's minimum order was invisible after the plan card: Recent showed the coin that was
// bought and nothing about the one that was not. The dropped line now follows that period's own buy line, naming
// the coin in the same words the plan card and the buy summary use (droppedLine, cards.mjs).
// Review finding (buy.mjs:503, later): a coin left unsent because an earlier coin's order is still waiting was
// named only in that run's own summary line, never recorded on period_done; status therefore never explained why
// the period bought nothing for it (rule 4, the same class the manage.mjs:97 fix already closed for checkFailed).
test('status names a coin not sent behind a waiting order in Recent, right after that period\'s own buy', async () => {
  const notFoundErr = () => new OkxError('Error: Order does not exist\nCode: 51603\n', 'cli', 'Error: Order does not exist\nCode: 51603\n');
  const okx = fakeExchange({ ...LOSING, getReply: (id, o) => (o ? { state: 'live', accFillSz: '0', avgPx: '' } : notFoundErr()) });
  const ctx = makeCtx({ env: OWNER, okx, now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  const done = ctx.store.readLedger().at(-1);
  assert.equal(done.kind, 'period_done');
  assert.deepEqual(done.notSent, ['BTC-USDT']);
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const lines = ctx.lines.filter((l) => l.startsWith('  2026-10-05'));
  // Review finding (manage.mjs, later): a history row is read well after the fact, possibly after the order in
  // question resolved one way or another; past tense ("was not known then") states only what was true then,
  // capitalized as its own sentence.
  assert.deepEqual(lines, [
    "  2026-10-05 Not sent, because an earlier order's result was not known then: BTC-USDT.",
  ]);
});

test('status names a dropped coin in Recent, right after that period\'s own buy', async () => {
  const balances = [
    bal('USDT', { eqUsd: '1000', availBal: '1000', openAvgPx: '', spotUplRatio: '' }),
    bal('ETH', { eqUsd: '500', spotUplRatio: '-0.99' }),
    bal('BTC', { eqUsd: '500', spotUplRatio: '-0.01' }),
  ];
  const instruments = [
    { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
    { instId: 'BTC-USDT', quoteCcy: 'USDT', state: 'live', minSz: '1', lotSz: '0.00000001' },
  ];
  const okx = fakeExchange({ balances, instruments, prices: { 'ETH-USDT': '1767.30', 'BTC-USDT': '84000.0' } });
  const ctx = makeCtx({ env: OWNER, okx, now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const lines = ctx.lines.filter((l) => l.startsWith('  2026-10-05'));
  assert.deepEqual(lines, [
    '  2026-10-05 ETH-USDT 10.00 USDT filled at 1767.30',
    "  2026-10-05 Too small for OKX's minimum order: BTC. Their share went to the others.",
  ]);
});

// Review finding (manage.mjs:97): a coin left unsent because the pre-send existing-order check itself failed is
// recorded on period_done.problems (buy.mjs), but no surface ever read it: status's Recent showed that period's
// buys with no trace of the coin held back.
test('status names a coin held back by a failed existing-order check in Recent', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = makeCtx({ env: OWNER, okx, now: T0 - 2 * HOUR });
  await planVerb(ctx, { ...flags, only: 'ETH' });
  await planVerb(ctx, { ...flags, only: 'ETH', confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  const json = okx.json;
  okx.json = async (args, call) => {
    if (args[0] === 'spot' && args[1] === 'get') throw new OkxError('connect ECONNREFUSED', 'network');
    return json(args, call);
  };
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const lines = ctx.lines.filter((l) => l.startsWith('  2026-10-05'));
  // Review finding (manage.mjs, later): each history part is now its own capitalized, period-closed sentence.
  assert.deepEqual(lines, ['  2026-10-05 Not sent: ETH-USDT (could not check whether it was already sent).']);
});

// Review finding (manage.mjs, later): historyLine joined its three period_done parts with a bare space. The
// "problems" part carried no closing period, so it ran straight into the next part with no separation at all, and
// a part after droppedLine's own trailing period started lowercase, as if still mid-sentence.
test('status joins a period_done\'s dropped, problems and notSent parts as separate, capitalized sentences', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const plan = activePlan(ctx.store.readLedger(), CALL);
  ctx.setNow(T0);
  ctx.store.appendLedger({
    kind: 'period_done', planId: plan.id, period: '2026-10-05', profile: 't', env: 'live',
    dropped: [{ ccy: 'DOGE' }], problems: [{ instId: 'SOL-USDT' }], notSent: ['BTC-USDT'],
  }, ctx.now());
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const line = ctx.lines.find((l) => l.startsWith('  2026-10-05'));
  assert.equal(
    line,
    "  2026-10-05 Too small for OKX's minimum order: DOGE. Their share went to the others. Not sent: SOL-USDT (could not check whether it was already sent). Not sent, because an earlier order's result was not known then: BTC-USDT.",
  );
});

// Finding 3 of the 2026-09-27 release-readiness review: a halted plan writes no period line by design (buy returns
// at "The plan is halted" before any ledger write), so its quiet days say nothing about the schedule. status names
// the halt and never guesses that the schedule stopped firing.
test('status on a halted plan names the halt and never says the schedule may have stopped firing', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const plan = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'OKX did not accept API key t.' }, T0 + DAY);
  ctx.lines.length = 0;
  ctx.setNow(T0 + 9 * DAY);
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /HALTED: OKX did not accept API key t\./);
  assert.doesNotMatch(t, /due periods? ha(s|ve) no record|may have stopped firing/);
  // Review finding (manage.mjs:81, rule 4): heading a halted plan "Running:" said the opposite of the HALTED line
  // right below it.
  assert.match(t, /^Halted: 10\.00 USDT every day/m);
  assert.doesNotMatch(t, /^Running:/m);
});

// Section 10: status prints the period with its hour for an hourly plan (it prints the period as buy recorded it;
// nothing here assumes a 10-character date).
test('status shows the hour in the period for an hourly plan', async () => {
  const hourlyFlags = {
    profile: 't', budget: '10', every: 'hour', method: 'weighted', at: ':00',
  };
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, hourlyFlags);
  await planVerb(ctx, { ...hourlyFlags, confirm: 'AVGPLAN' });
  ctx.env = SCHEDULED;
  ctx.setNow(T0);
  await buyVerb(ctx, { profile: 't' });
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /Running: 10\.00 USDT every hour at :00 \(Europe\/Istanbul\)/);
  assert.match(t, /2026-10-05 10 ETH-USDT [\d.]+ USDT filled/);
});

test('status with no plan says so and names the next step', async () => {
  const ctx = makeCtx();
  await statusVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /No plan is running on profile t \(live\)/);
});

// Item 4 of the 2026-09-27 release audit: a scheduled run's own log (written by the cron redirect or the launchd
// plist, never by AvgKeeper itself) is surfaced by status only when its last line does not read like an ordinary
// finish.
test('status shows the scheduled log\'s tail once it ends with what looks like a crash', async () => {
  const ctx = await running();
  await statusVerb(ctx, { profile: 't' });
  assert.ok(!text(ctx).includes('scheduled run'), 'an ordinary run leaves nothing to warn about yet');
  fs.mkdirSync(ctx.store.home, { recursive: true });
  fs.writeFileSync(path.join(ctx.store.home, 'buy-t-live.log'), 'AvgKeeper bought 2026-10-05: ETH 5.00 USDT.\nTypeError: x is not a function\n');
  ctx.lines.length = 0;
  await statusVerb(ctx, { profile: 't' });
  const t = text(ctx);
  // Review finding (schedule.mjs:75 area, later): "last written" now reads in the plan's own local time, with its
  // zone named, the same way "Last run" and "Started" on this same screen already do, not a bare UTC ISO stamp.
  assert.match(t, /WARNING: the scheduled run's own log \(.*buy-t-live\.log\) ends with a line that does not read like an ordinary finish, last written \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Europe\/Istanbul\)\./);
  assert.doesNotMatch(t, /last written \d{4}-\d{2}-\d{2}T/);
  assert.ok(t.includes('TypeError: x is not a function'), t);
});

// Spec section 9, "Surfaces": status prints the mail line and the pending count, from the one shared reader
// mail.mjs's mailStatus also gives doctor (schedule.test.mjs has the matching doctor test).
test('status prints the mail line and the pending notice count from the shared reader', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), config: { mail: { to: 'a@b.co', level: 'all' } } });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const plan = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({
    kind: 'notice', id: `${plan.id}:2026-10-05:buy`, profile: 't', env: 'live', to: 'a@b.co', severity: 'info', subject: 's', body: 'b',
  }, ctx.now());
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /^Mail: every buy with its details, to a@b\.co\.$/m);
  assert.ok(t.includes(`Mail waiting to be sent: 1. See them: ${commandText('mail --pending --profile t')}.`), t);
});

test('status says Mail: off. when nothing is configured, and prints no pending line', async () => {
  const ctx = makeCtx({ okx: fakeExchange(LOSING) });
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /^Mail: off\.$/m);
  assert.ok(!t.includes('Mail waiting to be sent'));
});

test('stop ends the plan without a typed word', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null);
  assert.equal(kinds(ctx).at(-1), 'plan_stopped');
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.match(text(ctx), /No plan was running/);
});

// Item 3 of the 2026-09-27 release audit: stop's own text names the exact same two commands doctor prints for
// launchd (bootout, then rm the file), rather than a vague pointer back at doctor's own output.
test('stop names the exact launchd removal commands on macOS', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  const plistPath = launchdPlistPath(CALL, ctx.realHome);
  const [bootout, rm] = launchdRemoveLines(CALL, ctx.realHome);
  assert.equal(bootout, `launchctl bootout gui/$(id -u) ${shWord(plistPath)}`);
  assert.deepEqual(ctx.lines.slice(-3), [
    'If you installed a schedule line, it still runs and now buys nothing. To take it out:',
    `If you used launchd, run both: ${bootout}, then ${rm}.`,
    'If you used crontab, delete the AvgKeeper line from your crontab yourself (crontab -e).',
  ]);
});

test('stop names crontab removal only, off macOS', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  ctx.platform = 'linux';
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.deepEqual(ctx.lines.slice(-2), [
    'If you installed a schedule line, it still runs and now buys nothing. To take it out:',
    'If you used crontab, delete the AvgKeeper line from your crontab yourself (crontab -e).',
  ]);
  assert.doesNotMatch(text(ctx), /launchctl/);
});

// Finding 12 of the 2026-09-27 release-readiness review: a second stop, weeks later, used to say only "Nothing
// changed." Once a plan ever ran on this profile, it names the removal commands again, from local facts only.
test('a second stop still names the removal commands; a stop before any plan names none', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.doesNotMatch(text(ctx), /launchctl|crontab/);
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  await stopVerb(ctx, { profile: 't' });
  ctx.lines.length = 0;
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  const [bootout, rm] = launchdRemoveLines(CALL, ctx.realHome);
  assert.deepEqual(ctx.lines, [
    'No plan was running on profile t (live). Nothing changed.',
    'If a schedule line from an earlier plan is still installed, take it out:',
    `If you used launchd, run both: ${bootout}, then ${rm}.`,
    'If you used crontab, delete the AvgKeeper line from your crontab yourself (crontab -e).',
  ]);
});

async function running() {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  return ctx;
}
const sent = (ctx, instId, clOrdId) => ctx.store.appendLedger({
  kind: 'buy_sent', planId: activePlan(ctx.store.readLedger(), CALL).id, period: '2026-10-05', instId, clOrdId, amount: '5.00', lossPct: 5, profile: 't', env: 'live',
}, T0);

// Item 2 of the 2026-09-26 review: a stop records every open send as unknown and names it, before plan_stopped.
// Review finding (manage.mjs:231, should): both sends belong to the same period and neither ever settled any
// other way, so once markSendsUnknown marks them both, that period is fully accounted for (planview.mjs's
// stalePeriods counts buy_unknown as settled too) and closeStalePeriods, now running after both writes above,
// closes it with its own period_done: a period stop leaves fully unknown must not stay open forever either.
test('stop records each open send as unknown, names it, closes the now-settled period, then stops the plan', async () => {
  const ctx = await running();
  sent(ctx, 'ETH-USDT', 'akone');
  sent(ctx, 'BTC-USDT', 'aktwo');
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  const tail = ctx.store.readLedger().slice(-4);
  // Review finding (manage.mjs:201, should): plan_stopped is written first, the same order halt() uses, so a
  // crash right after it still leaves the plan on record as stopped.
  assert.deepEqual(tail.map((e) => e.kind), ['plan_stopped', 'buy_unknown', 'buy_unknown', 'period_done']);
  assert.deepEqual(tail.slice(1, 3).map((e) => e.clOrdId), ['akone', 'aktwo']);
  assert.equal(tail[1].error, 'the plan was stopped before this order was read back');
  const expected = `Check order(s) in the OKX app: ${orderName('ETH-USDT', '5.00', '2026-10-05', 'akone')}, ${orderName('BTC-USDT', '5.00', '2026-10-05', 'aktwo')}.`;
  assert.ok(text(ctx).includes(expected), text(ctx));
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null);
});

// Review finding (manage.mjs:201, should): stop must write plan_stopped BEFORE it marks open sends unknown, the
// same order halt() already uses. A crash between the two writes must never leave a still-unsettled send marked
// unknown on a plan the ledger still shows as active (spec section 5: the system never continues by itself after a
// money move whose outcome is unknown).
test('stop writes plan_stopped before marking a send unknown, so a crash right after it still leaves the plan stopped', async () => {
  const ctx = await running();
  sent(ctx, 'ETH-USDT', 'akone');
  const real = ctx.store.appendLedger.bind(ctx.store);
  let calls = 0;
  ctx.store.appendLedger = (e, now) => {
    calls += 1;
    // Exactly two ledger writes happen inside stop for one open send: plan_stopped and one buy_unknown. Whichever
    // order the code uses, the second call is made to throw, so this test only ever proves the FIRST write landed.
    if (calls === 2) throw new Error('ENOSPC');
    return real(e, now);
  };
  await assert.rejects(() => stopVerb(ctx, { profile: 't' }));
  ctx.store.appendLedger = real;
  const ledger = ctx.store.readLedger();
  assert.equal(ledger[ledger.length - 1].kind, 'plan_stopped');
  assert.equal(activePlan(ledger, CALL), null);
  // The next scheduled run must see the plan as stopped and buy nothing, even though the ETH send was never
  // marked unknown by the crashed stop.
  ctx.setNow(T0 + DAY);
  ctx.env = SCHEDULED;
  const before = places(ctx.okx).length;
  assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
  assert.equal(places(ctx.okx).length, before);
});

// Review finding (manage.mjs:199 area, should): the crash above (plan_stopped landed, its own buy_unknown did
// not) leaves a send unsettled with no plan running at all. buy sees no plan and buys nothing; before this fix, a
// second stop claimed "Nothing changed" and left the send unsettled forever, with confirm refusing on it for good
// (its own clue pointed at a scheduled run that would never come). Stop's own no-plan branch now clears it too.
test('a second stop clears a send an earlier crash left unsettled with no plan running', async () => {
  const ctx = await running();
  sent(ctx, 'ETH-USDT', 'akone');
  const real = ctx.store.appendLedger.bind(ctx.store);
  let calls = 0;
  ctx.store.appendLedger = (e, now) => {
    calls += 1;
    if (calls === 2) throw new Error('ENOSPC');
    return real(e, now);
  };
  await assert.rejects(() => stopVerb(ctx, { profile: 't' }));
  ctx.store.appendLedger = real;
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null, 'no plan is running after the crashed stop');
  ctx.lines.length = 0;
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  const tail = ctx.store.readLedger().at(-1);
  assert.equal(tail.kind, 'buy_unknown');
  assert.equal(tail.clOrdId, 'akone');
  const t = text(ctx);
  assert.match(t, /1 order from an earlier plan was not read back yet and is now recorded as unknown/, t);
  assert.ok(t.includes(orderName('ETH-USDT', '5.00', '2026-10-05', 'akone')), t);
  assert.doesNotMatch(t, /Nothing changed/, t);
});

// Review finding (manage.mjs:201, should, paths lens): a run that dies partway through a period leaves a stale
// period (a coin filled, no period_done, no notice). Only the next scheduled run of the SAME plan life closed it
// before this; stop ended the plan without ever mentioning money that period already spent (spec section 9: money
// spent reaches a mail with its details on every path).
test('stop closes a stale period from an earlier run that died mid-period, and mails its detail line', async () => {
  const ctx = makeCtx({
    env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR, config: { notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'all', command: 'cat' } },
  });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const planId0 = activePlan(ctx.store.readLedger(), CALL).id;
  const ethId = buyClOrdId({
    planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', profile: 't', demo: false,
  });
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '5.00', lossPct: 5, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '5.00', profile: 't', env: 'live', notional: 5.0, accFillSz: '0.00283', avgPx: '1767.30',
  }, T0);
  ctx.setNow(T0 + 3 * HOUR);
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.ok(kinds(ctx).includes('period_done'), kinds(ctx).join(','));
  const resolveLine = ctx.notified.find((l) => l.includes('stopped partway'));
  assert.match(resolveLine || '', /The run for 2026-10-05 stopped partway; it had recorded these orders: ETH-USDT\./);
  assert.equal(ctx.mailed.length, 1);
  assert.match(ctx.mailed[0].body, /ETH-USDT: share 5\.00 USDT/);
});

// Review finding (manage.mjs:231, should): stopLocked called closeStalePeriods before markSendsUnknown, so a
// period that died mid-send (one coin filled, the next still open with no result read back) found nothing stale
// yet: the open send was not yet marked settled. markSendsUnknown then settled it, but nothing ever re-checked the
// period afterward, so it stayed open forever with no period_done and its fill reached no mail. closeStalePeriods
// must run only once its own open sends are already marked unknown.
test('stop closes a period whose last coin died mid-send, after marking the still-open one unknown', async () => {
  const ctx = makeCtx({
    env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR, config: { notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'all', command: 'cat' } },
  });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const planId0 = activePlan(ctx.store.readLedger(), CALL).id;
  const ethId = buyClOrdId({
    planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', profile: 't', demo: false,
  });
  const btcId = buyClOrdId({
    planId: planId0, period: '2026-10-05', instId: 'BTC-USDT', profile: 't', demo: false,
  });
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '6.67', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '6.67', profile: 't', env: 'live', notional: 6.67, accFillSz: '0.00377', avgPx: '1767.30',
  }, T0);
  // BTC never got a result read back before the run died: still open when stop runs.
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'BTC-USDT', clOrdId: btcId, amount: '3.33', lossPct: 5, profile: 't', env: 'live',
  }, T0);
  ctx.setNow(T0 + 3 * HOUR);
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.ok(kinds(ctx).includes('buy_unknown'), kinds(ctx).join(','));
  assert.ok(kinds(ctx).includes('period_done'), 'the period must still be closed, not left open forever');
  const resolveLine = ctx.notified.find((l) => l.includes('stopped partway'));
  assert.match(resolveLine || '', /ETH-USDT/, resolveLine || '(no stopped-partway notice at all)');
  assert.ok(ctx.mailed.some((m) => /ETH-USDT: share 6\.67 USDT/.test(m.body)), JSON.stringify(ctx.mailed));
});

test('stop refuses while another run holds the buy lock, and changes nothing', async () => {
  const ctx = await running();
  const held = ctx.store.lock('buy-t-live');
  const before = ctx.store.readLedger().length;
  assert.equal(await stopVerb(ctx, { profile: 't' }), 1);
  held();
  assert.match(text(ctx), /REFUSED: Another AvgKeeper run holds the buy lock for this profile\./);
  assert.equal(ctx.store.readLedger().length, before);
  assert.ok(activePlan(ctx.store.readLedger(), CALL));
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.ok(ctx.store.lock('buy-t-live'));
});

// Review finding (planview.mjs:73): staleLockLine's non-read-only form always said "AvgKeeper could not buy", even
// for stop, which reads as the plan still buying nothing when in fact it is still on and will buy again once the
// lock is gone.
test('stop refuses on a stale lock saying it could not stop the plan, never "could not buy"', async () => {
  const ctx = await running();
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  const old = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(f, old, old);
  assert.equal(await stopVerb(ctx, { profile: 't' }), 1);
  const t = text(ctx);
  assert.match(t, /REFUSED: AvgKeeper could not stop the plan; it is still on and buys again once the lock is gone: a lock from \d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  assert.doesNotMatch(t, /could not buy/);
  assert.ok(activePlan(ctx.store.readLedger(), CALL));
});

test('status prints the Waiting line for one and for two unsettled sends', async () => {
  const ctx = await running();
  sent(ctx, 'ETH-USDT', 'akone');
  await statusVerb(ctx, { profile: 't' });
  assert.ok(ctx.lines.includes('Waiting: 1 order whose result is not recorded yet; the next scheduled run reads it back.'));
  ctx.lines.length = 0;
  sent(ctx, 'BTC-USDT', 'aktwo');
  await statusVerb(ctx, { profile: 't' });
  assert.ok(ctx.lines.includes('Waiting: 2 orders whose results are not recorded yet; the next scheduled run reads them back.'));
});

// Finding 16 remaining: a halted plan never reads its own open sends back again (buy.mjs's halt() ends before any
// lock is taken again), but the Waiting line still promised "the next scheduled run reads it back", the opposite
// of what plan.mjs already tells the user at confirm time (rule 4: a fact one surface knows, every surface knows).
test('status\'s Waiting line names stop for a halted plan, never a read-back that will not happen', async () => {
  const ctx = await running();
  sent(ctx, 'ETH-USDT', 'akone');
  const plan = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'something unknown.' }, ctx.now());
  ctx.lines.length = 0;
  await statusVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.doesNotMatch(t, /the next scheduled run reads it back/);
  assert.match(t, /Waiting: 1 order whose result is not recorded yet\. The plan is halted and never reads it back on its own\. Run stop to clear it, then make a new plan\./);
});

// Item 6 of the 2026-09-26 review: status only ever reads the lock, it never tries to buy, so it never says
// "AvgKeeper could not buy". It still names the same time zone warning buy uses.
test('status names a stale buy lock read-only, and a time zone change with the sentence buy uses', async () => {
  const ctx = await running();
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  const old = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(f, old, old);
  ctx.timeZone = 'Asia/Tokyo';
  await statusVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /The buy lock from \d{4}-\d\d-\d\dT\d\d:\d\dZ is still held \(another AvgKeeper run, or one that crashed\)\./);
  assert.ok(t.includes(`If no AvgKeeper run is working, delete ${ctx.store.home}/buy-t-live.lock.`), t);
  assert.doesNotMatch(t, /could not buy/);
  assert.ok(ctx.lines.includes('WARNING: this plan was made in Europe/Istanbul, but this Mac is now on Asia/Tokyo. The schedule fires at machine time, so make a new plan and run doctor again.'));
  ctx.lines.length = 0;
  fs.rmSync(f);
  ctx.timeZone = 'Europe/Istanbul';
  await statusVerb(ctx, { profile: 't' });
  assert.doesNotMatch(text(ctx), /still held|WARNING/);
});

test('holdings refuses a bad --dust before reading OKX, and reads a good one', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = makeCtx({ okx });
  assert.equal(await holdingsVerb(ctx, { profile: 't', dust: 'ten' }), 1);
  assert.match(text(ctx), /REFUSED: --dust must be a USDT amount with at most two decimals; it reads ten\./);
  assert.equal(okx.calls.length, 0);
  assert.equal(await holdingsVerb(ctx, { profile: 't', dust: '500' }), 0);
  assert.match(text(ctx), /ETH\s+208\.90 USDT\s+-10\.00%\s+out: worth under 500\.00 USDT/);
});

// Review finding (manage.mjs:78, later): while a plan is running, holdings silently used the running plan's own
// dust threshold and ignored --dust with no word at all about either fact.
test('holdings says --dust is ignored while a plan runs, and names the threshold actually used', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  assert.equal(await holdingsVerb(ctx, { profile: 't', dust: '5' }), 0);
  const t = text(ctx);
  assert.match(t, /Using the running plan's dust threshold 10\.00 USDT; --dust applies only with no plan\./);
  // --dust is genuinely ignored: the plan's own 10.00 threshold decides, not the 5 passed in.
  assert.doesNotMatch(t, /worth under 5\.00 USDT/);
});

// Review finding (manage.mjs:84, later): an only-these plan applies no dust threshold at all (reasonOut skips
// the dust check once `only` is set, and coinsLine's own card text never mentions one for such a plan either), so
// naming a threshold it never actually uses claimed a fact that is not true for this plan.
test('holdings says --dust has no effect on an only-these plan, never a threshold it does not use', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, { ...flags, only: 'BTC,USDC' });
  await planVerb(ctx, { ...flags, only: 'BTC,USDC', confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  assert.equal(await holdingsVerb(ctx, { profile: 't', dust: '5' }), 0);
  const t = text(ctx);
  assert.doesNotMatch(t, /dust threshold/, t);
  assert.match(t, /The running plan only ever buys BTC, USDC \(--only\), so --dust has no effect on it\./, t);
});

// Review finding (manage.mjs:84, later): the dust-threshold line called a halted plan "running", the same
// mislabel rule 4's other fixes (manage.mjs:81) already closed for every other line on this screen.
test('holdings words a halted plan\'s own dust line without calling it "running"', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const plan = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'test halt' }, ctx.now());
  ctx.lines.length = 0;
  assert.equal(await holdingsVerb(ctx, { profile: 't', dust: '5' }), 0);
  const t = text(ctx);
  assert.match(t, /Using the halted plan's dust threshold 10\.00 USDT; --dust applies only with no plan\./, t);
  assert.doesNotMatch(t, /running plan's dust/, t);
});

test('notify --level writes the level and refuses an unknown one', async () => {
  const ctx = makeCtx({ config: { notify: 'cat' } });
  assert.equal(await notifyVerb(ctx, { level: 'all' }), 0);
  assert.deepEqual(ctx.store.readConfig(), { notify: 'cat', notifyLevel: 'all' });
  assert.equal(await notifyVerb(ctx, { level: 'loud' }), 1);
  assert.equal(await notifyVerb(ctx, {}), 0);
  assert.match(text(ctx), /Notify level: all/);
});

// Review finding (schedule.mjs:244): "so nothing reaches you" is false whenever mail is on with no notify command.
// New regression (schedule.mjs:449): "(see the Mail line)" points at a line this screen never prints, and with no
// mail.command it promised delivery mail does not actually have on its own.
test('notify with no command describes what mail actually does, never a dangling pointer', async () => {
  const noMail = makeCtx();
  assert.equal(await notifyVerb(noMail, {}), 0);
  assert.match(text(noMail), /No notify command is set yet, so nothing reaches you this way\. Add one yourself/);

  // Mail on, no mail.command: it does not reach the user on its own, it only waits for the agent.
  const noCommand = makeCtx({ config: { mail: { to: 'a@b.co', level: 'problems' } } });
  assert.equal(await notifyVerb(noCommand, {}), 0);
  const t1 = text(noCommand);
  assert.doesNotMatch(t1, /see the Mail line/);
  assert.match(t1, /No notify command is set yet, so nothing reaches you this way\. A skipped \(except for no coin in loss\) or halted buy is prepared as a mail notice \(Mail: problems only, to a@b\.co\) that waits until you ask your agent to send it: no mail command is set\. Add one yourself/);

  // Mail on, with a command: it does reach the user on its own.
  const withCommand = makeCtx({ config: { mail: { to: 'a@b.co', level: 'all', command: 'cat' } } });
  assert.equal(await notifyVerb(withCommand, {}), 0);
  const t2 = text(withCommand);
  assert.doesNotMatch(t2, /see the Mail line/);
  assert.match(t2, /No notify command is set yet, so nothing reaches you this way\. A skipped or halted buy also reaches you by mail \(Mail: every buy with its details, to a@b\.co\)\. Add one yourself/);
});

// ADDITION (project rule 4): a torn ledger line is named on every surface that reads the ledger, not only the one
// that first noticed it, so status shows the same warning doctor or check would show elsewhere.
test('status warns once about a torn ledger line', async () => {
  const ctx = makeCtx();
  ctx.store.appendLedger({ kind: 'plan_stopped', planId: 'p1', profile: 't', env: 'live', reason: 'x' }, ctx.now());
  const ledgerPath = path.join(ctx.store.home, 'ledger.jsonl');
  fs.appendFileSync(ledgerPath, 'not json\n');
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.ok(t.includes(`WARNING: line 2 of ${ctx.store.home}/ledger.jsonl could not be read and was skipped. Every scheduled buy refuses until that line is fixed or removed; a second bad line stops every AvgKeeper command.`), t);
});

// Review finding (planview.mjs:185, should): a torn line can be the very plan_stopped that ended the plan status
// then reads as active; heading it a bare "Running:" claims a certainty the code does not have while a line right
// above it could not be read.
test('status never heads a plan "Running:" with no caveat while the ledger is torn', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), 'not json\n');
  ctx.lines.length = 0;
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.doesNotMatch(t, /^Running: /m);
  assert.match(t, /Running \(unconfirmed while a ledger line is torn, see the WARNING above\): 10\.00 USDT every day/);
});

// Review finding (planview.mjs:185, should): stop used to print no torn warning at all (unlike status, doctor,
// holdings and plan), and over a torn line that hid the very plan_active it should have found, it claimed "No plan
// was running ... Nothing changed." with a certainty the code does not have.
test('stop prints the torn warning and refuses to claim no plan is running while the ledger is torn', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  const file = path.join(ctx.store.home, 'ledger.jsonl');
  // The would-be plan_active line itself is unreadable, the same as probe B (planview.mjs:185): activePlan then
  // finds nothing, although a plan may in fact be running.
  fs.appendFileSync(file, '{"kind":"plan_active","id":\n');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(await stopVerb(ctx, { profile: 't' }), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const t = text(ctx);
  assert.match(t, /WARNING: line 1 of .*ledger\.jsonl could not be read and was skipped/);
  assert.doesNotMatch(t, /No plan was running.*Nothing changed/);
  assert.match(t, /REFUSED: AvgKeeper cannot tell whether a plan is running while a ledger line cannot be read/);
});

// Item 11 of the 2026-09-26 review: holdings reads the ledger too (for the running plan), so it shows the same
// torn-line warning status and doctor show.
test('holdings warns about a torn ledger line', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = makeCtx({ okx });
  ctx.store.appendLedger({ kind: 'plan_stopped', planId: 'p1', profile: 't', env: 'live', reason: 'x' }, ctx.now());
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), 'not json\n');
  assert.equal(await holdingsVerb(ctx, { profile: 't' }), 0);
  assert.ok(text(ctx).includes(`WARNING: line 2 of ${ctx.store.home}/ledger.jsonl could not be read and was skipped. Every scheduled buy refuses until that line is fixed or removed; a second bad line stops every AvgKeeper command.`), text(ctx));
});

// Review finding (manage.mjs:199 area, later): stop already refuses outright rather than claim no plan is running
// while a ledger line cannot be read; status and holdings still stated it as a plain fact and invited a plan card,
// which the card would then say AVGPLAN is certain to refuse (rule 4, a fact one surface knows, every surface
// knows). The skipped line here is the would-be plan_active itself, so a plan may in fact be running.
test('status hedges "no plan is running" while the ledger is torn, instead of stating it as fact', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), '{"kind":"plan_active","id":\n');
  assert.equal(await statusVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /WARNING: line 1 of .*ledger\.jsonl could not be read and was skipped/, t);
  assert.match(t, /No plan is running on profile t \(live\)\. Ask your agent for a plan card to start one\. AvgKeeper cannot be sure: a ledger line could not be read \(see the WARNING above\)\./, t);
});

test('holdings hedges "no plan is running" while the ledger is torn, instead of stating it as fact', async () => {
  const ctx = makeCtx({ okx: fakeExchange(LOSING) });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), '{"kind":"plan_active","id":\n');
  assert.equal(await holdingsVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /WARNING: line 1 of .*ledger\.jsonl could not be read and was skipped/, t);
  assert.match(t, /No plan is running yet on profile t \(live\); ask your agent for a plan card to start one\. AvgKeeper cannot be sure: a ledger line could not be read \(see the WARNING above\)\./, t);
});
