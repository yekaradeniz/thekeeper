// avgkeeper/tests/store.test.mjs
import { tmpDir } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createStore, homeDir, LEDGER_SCHEMA, LOCK_STALE_MS, displayHomePath,
} from '../scripts/store.mjs';

test('homeDir follows AVGKEEPER_HOME and refuses the real home under node --test', () => {
  assert.equal(homeDir({ AVGKEEPER_HOME: '/tmp/x' }), '/tmp/x');
  assert.throws(() => homeDir({}), /temporary AvgKeeper home/);
});

// Review finding (planview.mjs:77): a hard-coded ~/.avgkeeper names the wrong file whenever AVGKEEPER_HOME points
// elsewhere. The ~/.avgkeeper shorthand is shown only for that one, real, unoverridden home; any other home (an
// override, or a test's own temp store) is shown in full.
test('displayHomePath shows ~/.avgkeeper only for the real default home, the full path otherwise', () => {
  const real = path.join(os.homedir(), '.avgkeeper');
  assert.equal(displayHomePath(real), '~/.avgkeeper');
  assert.equal(displayHomePath(real, 'ledger.jsonl'), '~/.avgkeeper/ledger.jsonl');
  assert.equal(displayHomePath('/opt/flora/avgkeeper', 'ledger.jsonl'), '/opt/flora/avgkeeper/ledger.jsonl');
  assert.equal(displayHomePath('/tmp/ak-store-xyz'), '/tmp/ak-store-xyz');
});

test('appendLedger stamps ts and v, readLedger reads it back', () => {
  const s = createStore(tmpDir('ak-store-'));
  s.appendLedger({ kind: 'plan_card', planId: 'p1' }, Date.UTC(2026, 9, 5));
  const [row] = s.readLedger();
  assert.equal(row.kind, 'plan_card');
  assert.equal(row.ts, '2026-10-05T00:00:00.000Z');
  assert.equal(row.v, LEDGER_SCHEMA);
  assert.equal(LEDGER_SCHEMA, 1);
});

test('one torn line is tolerated, two refuse', () => {
  const home = tmpDir('ak-store-');
  const s = createStore(home);
  s.appendLedger({ kind: 'a' });
  fs.appendFileSync(path.join(home, 'ledger.jsonl'), '{"kind":\n');
  assert.equal(s.readLedger().length, 1);
  fs.appendFileSync(path.join(home, 'ledger.jsonl'), 'null\n');
  assert.throws(() => s.readLedger(), /cannot be read as ledger lines/);
});

test('a lock is held until released', () => {
  const s = createStore(tmpDir('ak-store-'));
  const release = s.lock('buy-t-live');
  assert.equal(typeof release, 'function');
  assert.equal(s.lock('buy-t-live'), null);
  release();
  const again = s.lock('buy-t-live');
  assert.equal(typeof again, 'function');
  again();
});

test('config round trips and files are private', () => {
  const home = tmpDir('ak-store-');
  const s = createStore(home);
  s.writeConfig({ notify: 'cat', notifyLevel: 'all' });
  assert.deepEqual(s.readConfig(), { notify: 'cat', notifyLevel: 'all' });
  assert.equal(fs.statSync(path.join(home, 'config.json')).mode & 0o777, 0o600);
});

// A dead pid (one that does not exist on this machine) is never a legitimately running holder, whatever the
// lock's age: pid reuse after a reboot must never wedge a lock forever.
test('a stale lock whose pid is dead is taken over even though the lock itself is fresh', () => {
  const home = tmpDir('ak-store-');
  const s = createStore(home);
  const deadPid = 2 ** 30; // not a real pid on this machine
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'buy-t-live.lock'), JSON.stringify({ pid: deadPid, start: Date.now() }));
  const release = s.lock('buy-t-live');
  assert.equal(typeof release, 'function');
  release();
});

// Item 1 of the 2026-09-26 review: an empty or unparsable lock past LOCK_STALE_MS is taken over whatever takeover
// says, a young one is held, and a stale live-pid lock stays held under takeover false.
test('a 20-minute-old empty or garbage lock is taken over even with takeover false; a young one is held', () => {
  const home = tmpDir('ak-store-');
  const s = createStore(home);
  fs.mkdirSync(home, { recursive: true });
  const f = path.join(home, 'buy-t-live.lock');
  const age = (p, minutes) => {
    const t = (Date.now() - minutes * 60000) / 1000;
    fs.utimesSync(p, t, t);
  };
  for (const content of ['', 'not json', '{}']) {
    fs.writeFileSync(f, content);
    age(f, 1);
    assert.equal(s.lock('buy-t-live', { takeover: false }), null, `young ${JSON.stringify(content)}`);
    assert.equal(s.staleLock('buy-t-live'), null);
    age(f, 20);
    assert.ok(s.staleLock('buy-t-live') >= 20 * 60000 - 1000);
    const release = s.lock('buy-t-live', { takeover: false });
    assert.equal(typeof release, 'function', `stale ${JSON.stringify(content)}`);
    release();
    assert.ok(!fs.existsSync(f));
  }
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  age(f, 20);
  assert.equal(s.lock('buy-t-live', { takeover: false }), null);
  assert.ok(s.staleLock('buy-t-live') >= LOCK_STALE_MS);
  fs.rmSync(f);
  assert.equal(s.staleLock('buy-t-live'), null);
});

// Review findings (buy.mjs:568, period.mjs:315): lock(name, {takeover:false}) itself takes over a dead pid, or
// empty/garbage content, at any age, and holds a live or EPERM pid whatever its age. lockDecision answers exactly
// that question, with no side effect, so a dry run or status can never name a lock as a cause the real gate would
// not act on.
test('lockDecision answers what lock(name, {takeover:false}) would do right now, with no side effect', () => {
  const home = tmpDir('ak-store-');
  const s = createStore(home);
  assert.equal(s.lockDecision('buy-t-live'), 'none', 'no lock file at all');
  fs.mkdirSync(home, { recursive: true });
  const f = path.join(home, 'buy-t-live.lock');
  const age = (minutes) => {
    const t = (Date.now() - minutes * 60000) / 1000;
    fs.utimesSync(f, t, t);
  };
  // A live pid is held whatever its age: a scheduled buy's own read-backs can run long past LOCK_STALE_MS.
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  age(1);
  assert.equal(s.lockDecision('buy-t-live'), 'held');
  age(20);
  assert.equal(s.lockDecision('buy-t-live'), 'held');
  // A dead pid is never held, whatever its age: pid reuse after a reboot must never wedge a lock forever.
  const deadPid = 2 ** 30;
  fs.writeFileSync(f, JSON.stringify({ pid: deadPid, start: 1 }));
  age(1);
  assert.equal(s.lockDecision('buy-t-live'), 'takeover', 'a dead pid is taken over even fresh');
  age(20);
  assert.equal(s.lockDecision('buy-t-live'), 'takeover');
  // Empty or garbage content: held only while young, taken over once stale, lock()'s own rule for it.
  fs.writeFileSync(f, '');
  age(1);
  assert.equal(s.lockDecision('buy-t-live'), 'held');
  age(20);
  assert.equal(s.lockDecision('buy-t-live'), 'takeover');
  // Read only: the file this whole test wrote by hand is still exactly where it left it.
  assert.ok(fs.existsSync(f));
});

// mkdir and write modes apply only on creation; every store call also sets them on what already exists, so a
// file created outside AvgKeeper with looser permissions is not left readable by other users on this machine.
test('chmod applies to a config file and a ledger that already existed with mode 0644', { skip: process.platform === 'win32' }, () => {
  const home = tmpDir('ak-store-');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), '{}', { mode: 0o644 });
  fs.writeFileSync(path.join(home, 'ledger.jsonl'), '', { mode: 0o644 });
  const s = createStore(home);
  s.writeConfig({});
  s.appendLedger({ kind: 'a' });
  const mode = (p) => fs.statSync(path.join(home, p)).mode & 0o777;
  assert.equal(mode('config.json'), 0o600);
  assert.equal(mode('ledger.jsonl'), 0o600);
});
