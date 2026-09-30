// avgkeeper/tests/independence.test.mjs
// AvgKeeper and GridKeeper are separate products (owner, 2026-09-27): a user may install one without the other, and
// the two must never mix. AvgKeeper imports nothing from GridKeeper, reads none of its environment variables, state
// folder or launchd labels, names it nowhere a user or an agent reads, and runs when its folder is copied alone.
// Comments may still record where a rule came from; only code and shipped text are checked.
import { AK_ROOT, tmpDir, withoutComments } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buySchedule, launchdLabel } from '../scripts/schedule.mjs';

const SCRIPTS_DIR = path.join(AK_ROOT, 'scripts');
const scriptFiles = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'));

// Every way a GridKeeper link has shown up or could: an import path, its env prefix, its state folder, its launchd
// label, and its name in a string (the plan card once carried a GridKeeper sentence, removed in review 2026-09-26).
const LINKS = [/gridkeeper/i, /GRIDKEEPER_/, /\.\.\/\.\.\//];

test('no script links to GridKeeper in code or in a string', () => {
  const offenders = [];
  for (const f of scriptFiles) {
    const code = withoutComments(fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'));
    for (const re of LINKS) {
      const m = code.match(re);
      if (m) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Later item L3 of the 2026-09-27 release-readiness review: every shipped document a user or an agent reads, the
// key guide under references/ included, not only SKILL.md and README.md.
test('no shipped document names GridKeeper: SKILL.md, README.md and every references/*.md', () => {
  const docs = ['SKILL.md', 'README.md', ...fs.readdirSync(path.join(AK_ROOT, 'references')).filter((f) => f.endsWith('.md')).map((f) => `references/${f}`)];
  assert.ok(docs.includes('references/api-key-setup.md'), docs.join(', '));
  for (const f of docs) {
    assert.ok(!/gridkeeper/i.test(fs.readFileSync(path.join(AK_ROOT, f), 'utf8')), f);
  }
});

test('the schedule uses only AvgKeeper names', () => {
  const bin = tmpDir('ak-bin-');
  fs.writeFileSync(path.join(bin, 'okx'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'okx'), 0o755);
  const s = buySchedule({ PATH: bin, HOME: '/Users/x', AVGKEEPER_OWNER_TEST: '1' }, { profile: 't', demo: true }, { at: '10:00' });
  for (const [k] of s.cronEnv) assert.ok(['HOME', 'PATH'].includes(k) || k.startsWith('AVGKEEPER_'), k);
  assert.match(launchdLabel({ profile: 't', demo: true }), /^com\.avgkeeper\./);
});

// Review finding (independence.test.mjs:52): the catalog's entry-no-realpath mutant (avgkeeper.mjs's own isMain
// check) was killed only by macOS's /var being a symlink to /private/var, an accident of where the OS puts temp
// files, not a test that deliberately reaches the entry script through one. On Linux, where /tmp is a real
// directory, reverting the realpath fix passed the whole suite. tmpDir()'s own result is realpath'd first, so this
// test does not depend on TMPDIR itself being a symlink either way; the symlink here is the one this test makes.
test('the entry script runs when reached through a symlink, not only by a symlinked TMPDIR', () => {
  const solo = fs.realpathSync(tmpDir('ak-symlink-'));
  const dest = path.join(solo, 'avgkeeper');
  fs.mkdirSync(dest);
  for (const entry of ['scripts', 'SKILL.md', 'README.md', 'package.json']) {
    fs.cpSync(path.join(AK_ROOT, entry), path.join(dest, entry), { recursive: true });
  }
  const link = path.join(solo, 'avgkeeper-link');
  fs.symlinkSync(dest, link);
  const home = path.join(solo, 'home');
  const r = spawnSync(process.execPath, [path.join(link, 'scripts', 'avgkeeper.mjs'), 'notify'], {
    env: { ...process.env, AVGKEEPER_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /Notify level: problems/);
});

test('the skill folder runs when copied alone, with no GridKeeper beside it', () => {
  const solo = tmpDir('ak-solo-');
  const dest = path.join(solo, 'avgkeeper');
  fs.mkdirSync(dest);
  for (const entry of ['scripts', 'SKILL.md', 'README.md', 'package.json']) {
    fs.cpSync(path.join(AK_ROOT, entry), path.join(dest, entry), { recursive: true });
  }
  const home = path.join(solo, 'home');
  const r = spawnSync(process.execPath, [path.join(dest, 'scripts', 'avgkeeper.mjs'), 'notify'], {
    env: { ...process.env, AVGKEEPER_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /Notify level: problems/);
  assert.ok(!fs.existsSync(path.join(solo, 'gridkeeper')));
});
