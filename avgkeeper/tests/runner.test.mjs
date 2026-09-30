// avgkeeper/tests/runner.test.mjs
import { tmpDir } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createRunner, ALLOWLIST, WRITES, classify, stripKeys, redactStderr, OKX_SHADOW_ENV, okxMessage } from '../scripts/runner.mjs';

// Seen live 2026-09-28: OKX's 50004 message is "API endpoint request timeout. " (a period and a space), and every
// sentence AvgKeeper builds around a reason adds its own punctuation: "(API endpoint request timeout. )" in the halt,
// "timeout. . Check it" in status. The one reader of OKX's message hands back the clause alone.
test('okxMessage hands back the clause without OKX\'s trailing space or period', () => {
  assert.equal(okxMessage('Error: API endpoint request timeout. \nCode: 50004'), 'API endpoint request timeout');
  assert.equal(okxMessage('Error: Insufficient balance\nCode: 51008'), 'Insufficient balance');
});

const FAKE = fileURLToPath(new URL('./fixtures/fake-okx.mjs', import.meta.url));
function runnerWith(spec) {
  const dir = tmpDir('ak-runner-');
  const file = path.join(dir, 'spec.json');
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, JSON.stringify(spec));
  const okx = createRunner({ env: { ...process.env, AVGKEEPER_OKX_BIN: FAKE, AK_FAKE: file, AK_FAKE_LOG: log }, sleep: async () => {} });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { okx, calls };
}

test('the allowlist is exactly the calls AvgKeeper makes', () => {
  assert.deepEqual([...ALLOWLIST].sort(), ['account balance', 'account config', 'config show', 'market instruments', 'market ticker', 'spot get', 'spot place']);
  assert.deepEqual([...WRITES], ['spot place']);
});

test('a call off the allowlist is refused before anything spawns', async () => {
  const { okx, calls } = runnerWith({});
  await assert.rejects(okx.json(['bot', 'grid', 'create']), (e) => e.kind === 'allowlist');
  assert.equal(calls().length, 0);
});

test('a read is retried once on a rate limit, a write never is', async () => {
  const rate = { stderr: 'Error: Rate limited\nHint: Rate limited, retry later\n', code: 1 };
  const a = runnerWith({ 'account balance': [rate, { stdout: { env: 'live', data: [] } }] });
  const r = await a.okx.json(['account', 'balance'], { profile: 't' });
  assert.deepEqual(r.data, []);
  assert.equal(a.calls().length, 2);
  const b = runnerWith({ 'spot place': [rate, { stdout: { env: 'live', data: [] } }] });
  await assert.rejects(b.okx.json(['spot', 'place', '--instId', 'ETH-USDT'], { profile: 't' }), (e) => e.kind === 'rate');
  assert.equal(b.calls().length, 1);
});

test('a demo run that reaches the live account is refused', async () => {
  const { okx } = runnerWith({ 'account balance': { stdout: { env: 'live', data: [] } } });
  await assert.rejects(okx.json(['account', 'balance'], { profile: 't', demo: true }), (e) => e.kind === 'env');
});

// sCodeRejection is the MAIN path for a rejected buy (spot_place_order returns normalizeResponse, never
// normalizeWrite, so a rejection never reaches classify's stderr-only reading; markFailedIfSCodeError exits 1
// with the reply rows still on stdout and stderr empty). It has to apply the same env check the exit-0 path
// does, or a rejected buy on the wrong account would return quietly instead of refusing.
test('a rejected spot place (exit 1, reply on stdout, empty stderr) returns the reply after exactly one call', async () => {
  const reply = { stdout: { env: 'live', data: [{ sCode: '51008', sMsg: 'Insufficient balance' }] }, code: 1 };
  const { okx, calls } = runnerWith({ 'spot place': reply });
  const r = await okx.json(['spot', 'place', '--instId', 'ETH-USDT'], { profile: 't' });
  assert.equal(r.data[0].sCode, '51008');
  assert.equal(r.data[0].sMsg, 'Insufficient balance');
  assert.equal(calls().length, 1);
});

// Review finding (orders.mjs:33): sCode null or blank on the reply row proves nothing, OKX sent no usable code at
// all, so the CLI-exit-1 safety net must not read it as a rejection either (orders.mjs's own sendBuy applies the
// same rule to sCode undefined already; sCodeMissing is the one reader both use, rule 3).
test('a spot place reply on stdout with sCode null or blank is not read as a rejection (exit 1, empty stderr)', async () => {
  for (const sCode of [null, '']) {
    const reply = { stdout: { env: 'live', data: [{ sCode, sMsg: '' }] }, code: 1 };
    const { okx, calls } = runnerWith({ 'spot place': reply });
    await assert.rejects(okx.json(['spot', 'place', '--instId', 'ETH-USDT'], { profile: 't' }), (e) => e.kind === 'cli');
    assert.equal(calls().length, 1, JSON.stringify(sCode));
  }
});

test('a rejected spot place on the wrong account is refused with kind env, not returned as data', async () => {
  const reply = { stdout: { env: 'live', data: [{ sCode: '51008', sMsg: 'Insufficient balance' }] }, code: 1 };
  const { okx } = runnerWith({ 'spot place': reply });
  await assert.rejects(
    okx.json(['spot', 'place', '--instId', 'ETH-USDT'], { profile: 't', demo: true }),
    (e) => e.kind === 'env',
  );
});

test('classify reads a network failure and an auth failure', () => {
  assert.equal(classify('Error: Failed to call OKX endpoint GET /x.\nHint: Please check network connectivity and retry the request', 1), 'network');
  assert.equal(classify('Error: x\nHint: Check API key, secret, passphrase and permissions', 1), 'auth');
});

test('OKX_SHADOW_ENV variables are removed from the child env, never reach the okx CLI', async () => {
  const dir = tmpDir('ak-runner-');
  const file = path.join(dir, 'spec.json');
  const dump = path.join(dir, 'envdump.jsonl');
  fs.writeFileSync(file, JSON.stringify({ 'account config': { stdout: { env: 'live', data: [] } } }));
  const okx = createRunner({
    env: {
      ...process.env, AVGKEEPER_OKX_BIN: FAKE, AK_FAKE: file, AK_FAKE_ENVDUMP: dump, AK_FAKE_ENVDUMP_KEYS: OKX_SHADOW_ENV.join(','),
      OKX_API_KEY: 'AK-other-tool', OKX_SECRET_KEY: 'SK-other-tool', OKX_PASSPHRASE: 'PP-other-tool',
      OKX_DEMO: '1', OKX_SITE: 'eea', OKX_API_BASE_URL: 'https://proxy.example',
    },
    sleep: async () => {},
  });
  await okx.json(['account', 'config'], { profile: 't' });
  const dumped = JSON.parse(fs.readFileSync(dump, 'utf8').trim());
  assert.deepEqual(dumped, Object.fromEntries(OKX_SHADOW_ENV.map((k) => [k, null])));
});

test('stripKeys removes api_key, secret_key and passphrase from a config show reply, both shapes', () => {
  const bare = { profiles: { t: { api_key: 'AK', secret_key: 'SK', passphrase: 'PP', demo: false } } };
  stripKeys(bare);
  assert.deepEqual(bare.profiles.t, { demo: false });
  const enveloped = { env: 'live', profile: 't', data: { profiles: { t: { api_key: 'AK', secret_key: 'SK', passphrase: 'PP' } } } };
  stripKeys(enveloped);
  assert.deepEqual(enveloped.data.profiles.t, {});
});

test('redactStderr hides the lines of an invalid TOML config, never the config path itself', () => {
  const stderr = 'Error: Invalid TOML document\n3:  api_key = "AKFAKE\n     ^\nVersion: 1.4.6';
  const out = redactStderr(stderr);
  assert.doesNotMatch(out, /AKFAKE/);
  assert.match(out, /hid the lines of your okx config/);
});

test('a call that hangs past the timeout is kind timeout', async () => {
  const dir = tmpDir('ak-runner-');
  const bin = path.join(dir, 'slow-okx.mjs');
  fs.writeFileSync(bin, "setTimeout(() => {}, 10000);\n");
  const okx = createRunner({ env: { ...process.env, AVGKEEPER_OKX_BIN: bin }, timeoutMs: 200, sleep: async () => {} });
  await assert.rejects(okx.json(['market', 'ticker', 'BTC-USDT']), (e) => e.kind === 'timeout');
});

test('an okx CLI that cannot be started at all is kind missing', async () => {
  const okx = createRunner({ env: { ...process.env, AVGKEEPER_OKX_BIN: path.join(os.tmpdir(), 'ak-no-such-dir', 'okx') }, sleep: async () => {} });
  await assert.rejects(okx.json(['account', 'balance'], { profile: 't' }), (e) => e.kind === 'missing' && /ENOENT/.test(e.message));
});
