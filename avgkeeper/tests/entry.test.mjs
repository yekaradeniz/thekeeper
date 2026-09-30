// avgkeeper/tests/entry.test.mjs
import { makeCtx, fakeExchange, LOSING, OWNER, text } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseArgs, USAGE } from '../scripts/avgkeeper.mjs';
import { OkxError } from '../scripts/runner.mjs';

const failing = (kind) => ({ raw: async () => { throw new OkxError('x', kind); }, json: async () => { throw new OkxError('x', kind); } });

test('parseArgs reads flags and refuses a value-less flag', () => {
  assert.deepEqual(parseArgs(['plan', '--profile', 't', '--demo', '--budget', '10']), { verb: 'plan', profile: 't', demo: true, budget: '10' });
  assert.throws(() => parseArgs(['plan', '--budget']), /--budget needs a value/);
});

// Item 7 of the 2026-09-26 review: a repeated flag silently kept only its last value, and --verb replaced the verb.
test('parseArgs refuses a repeated flag, including --verb', () => {
  assert.throws(() => parseArgs(['plan', '--budget', '10', '--budget', '1000']), /^Error: REFUSED: --budget was given twice\.$/);
  assert.throws(() => parseArgs(['buy', '--demo', '--demo']), /REFUSED: --demo was given twice\./);
  assert.throws(() => parseArgs(['status', '--verb', 'buy']), /REFUSED: --verb was given twice\./);
});

test('buy --launchd without --smoke is refused and reads nothing', async () => {
  const okx = fakeExchange(LOSING);
  const ctx = makeCtx({ env: OWNER, okx });
  assert.equal(await main(['buy', '--launchd', '--profile', 't', '--dry-run'], ctx), 1);
  assert.match(text(ctx), /REFUSED: --launchd goes with --smoke only\./);
  assert.equal(okx.calls.length, 0);
});

test('the usage line does not claim smoke checks the install', () => {
  assert.match(USAGE, /buy --smoke \[--launchd\] --profile <p> \[--demo\] {3}\(proves the buy line of the schedule runs; it does not check that it is installed\)/);
  assert.match(USAGE, /doctor --profile <p> \[--demo\] {3}\(checks the setup and whether the schedule AVGPLAN installed is in place\)/);
  assert.doesNotMatch(USAGE, /proves the installed/);
});

// Section 10: the usage text is a user-facing surface, so it names the hourly cadence and --at's :MM form.
test('the usage line names --every hour and the :MM form of --at', () => {
  assert.ok(USAGE.includes('--every hour|day|days:<n>|week:<mon..sun>|month:<1-31>'), USAGE);
  assert.ok(USAGE.includes('[--at HH:MM, or :MM with --every hour]'), USAGE);
  assert.ok(!USAGE.includes('[--at HH:MM]'), 'the daily-only --at form is gone');
});

// Item 10 of the 2026-09-27 release audit: refused in one sentence, before argv is even parsed, so every verb
// refuses the same way instead of failing later with a path or shell error.
test('AvgKeeper refuses to run on native Windows, before any verb is even parsed', async () => {
  const ctx = makeCtx();
  ctx.platform = 'win32';
  assert.equal(await main(['status', '--profile', 't'], ctx), 1);
  assert.match(text(ctx), /^REFUSED: AvgKeeper runs on macOS or Linux only; native Windows is not supported\.$/);
  ctx.lines.length = 0;
  assert.equal(await main(['nope'], ctx), 1);
  assert.match(text(ctx), /^REFUSED: AvgKeeper runs on macOS or Linux only; native Windows is not supported\.$/);
  assert.ok(!text(ctx).includes('Unknown verb'), 'the platform refusal comes before verb lookup');
});

test('AvgKeeper runs normally on macOS and Linux, never refusing for the platform', async () => {
  const ctx = makeCtx();
  for (const platform of ['darwin', 'linux']) {
    ctx.platform = platform;
    ctx.lines.length = 0;
    await main(['status', '--profile', 't'], ctx);
    assert.ok(!text(ctx).includes('native Windows'), platform);
  }
});

test('an unknown verb, an unknown flag and a bad profile are refused', async () => {
  const ctx = makeCtx();
  assert.equal(await main(['nope'], ctx), 1);
  assert.equal(await main(['status', '--profile', 't', '--budget', '1'], ctx), 1);
  assert.equal(await main(['status', '--profile', 'a b'], ctx), 1);
  assert.equal(await main(['status'], ctx), 1);
  const t = text(ctx);
  assert.match(t, /Unknown verb nope/);
  assert.match(t, /status does not take --budget/);
  assert.match(t, /profile name/);
  assert.match(t, /pass --profile/);
});

test('an auth failure and a missing CLI print one plain line', async () => {
  const auth = makeCtx({ okx: failing('auth') });
  assert.equal(await main(['holdings', '--profile', 't'], auth), 1);
  assert.match(text(auth), /OKX did not accept API key t/);
  const missing = makeCtx({ okx: failing('missing') });
  assert.equal(await main(['holdings', '--profile', 't'], missing), 1);
  assert.match(text(missing), /no okx CLI was found/);
});

test('main dispatches plan', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await main(['plan', '--profile', 't', '--budget', '10', '--every', 'day', '--method', 'equal'], ctx), 0);
  assert.match(text(ctx), /type AVGPLAN/);
});

test('buy --smoke routes to the smoke test, not the buy', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await main(['buy', '--smoke', '--profile', 't'], ctx), 1);
  assert.match(text(ctx), /FAIL: no plan yet, so there is no schedule to test/);
});
