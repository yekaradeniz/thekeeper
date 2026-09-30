// avgkeeper/tests/sched-guard.test.mjs
//
// The 2026-09-30 incident (see tests/tmp-guard.mjs's header): a test spawned the real entry script before its stubs
// were on PATH, and a real launchd job was bootstrapped into the developer's session. The guard is a marker
// (AVGKEEPER_TEST_GUARD=1, set by tmp-guard.mjs in every test process) that makes realSched refuse to look up
// `crontab` or `launchctl` on PATH. These tests pin the marker, its inheritance and the refusal.
import './tmp-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  tmpDir, makeCtx, fakeExchange, LOSING, OWNER,
} from './helpers.mjs';
import {
  realSched, schedBinary, fileRefusal, launchdPlistPath, installSchedule, removeSchedule,
} from '../scripts/schedule.mjs';

// A directory holding a crontab and a launchctl that would leave a file behind if they ever ran.
function trapDir() {
  const dir = fs.realpathSync(tmpDir('ak-schedtrap-'));
  const hit = path.join(dir, 'was-run');
  for (const name of ['crontab', 'launchctl']) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${hit}'\nexit 0\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return { dir, hit };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the guard marker is set in a test process and a node child inherits it', () => {
  assert.equal(process.env.AVGKEEPER_TEST_GUARD, '1', 'tests/tmp-guard.mjs must set the marker on load');
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.AVGKEEPER_TEST_GUARD))'], { encoding: 'utf8' });
  assert.equal(r.stdout, '1');
});

test('marker set, no stub directory: crontab and launchctl fail and spawn nothing, even with stubs on PATH', async () => {
  const { dir, hit } = trapDir();
  await withEnv({ AVGKEEPER_TEST_GUARD: '1', AVGKEEPER_SCHED_BIN_DIR: undefined, PATH: `${dir}:${process.env.PATH}` }, async () => {
    const s = realSched();
    for (const r of [await s.crontabRead(), await s.crontabWrite('x\n'), await s.launchctl(['bootstrap', 'gui/1', '/x.plist'])]) {
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /a test tried to reach the real scheduler/);
    }
  });
  assert.equal(fs.existsSync(hit), false, 'a stub on PATH ran, so the guard spawned a bare binary');
});

test('a relative stub directory counts as none', async () => {
  const { dir, hit } = trapDir();
  await withEnv({ AVGKEEPER_TEST_GUARD: '1', AVGKEEPER_SCHED_BIN_DIR: path.relative(process.cwd(), dir), PATH: `${dir}:${process.env.PATH}` }, async () => {
    const r = await realSched().crontabRead();
    assert.notEqual(r.code, 0);
  });
  assert.equal(fs.existsSync(hit), false);
});

test('marker set with an absolute stub directory: the binaries run from there only, never from PATH', async () => {
  const { dir, hit } = trapDir();
  const onPath = trapDir();
  assert.equal(schedBinary('crontab', { AVGKEEPER_TEST_GUARD: '1', AVGKEEPER_SCHED_BIN_DIR: dir }), path.join(dir, 'crontab'));
  // A second trap directory is FIRST on PATH: a lookup by bare name would run it, and its hit file would appear.
  await withEnv({ AVGKEEPER_TEST_GUARD: '1', AVGKEEPER_SCHED_BIN_DIR: dir, PATH: `${onPath.dir}:/usr/bin:/bin` }, async () => {
    const r = await realSched().launchctl(['print', 'gui/1/x']);
    assert.equal(r.code, 0);
  });
  assert.match(fs.readFileSync(hit, 'utf8'), /^launchctl print gui\/1\/x$/m);
  assert.equal(fs.existsSync(onPath.hit), false, 'the stub on PATH ran, so a bare name was looked up');
});

// The same guard for files (2026-09-30 review): under the marker, realSched's writeFile and removeFile refuse any
// path under the real user's home, which is what os.userInfo() says, not $HOME.
const realHome = os.userInfo().homedir;

test('marker set: realSched.writeFile and removeFile refuse a path under the real home and touch nothing', () => {
  // A name that can only exist if a guard failed; the finally below removes it if one did.
  const folder = path.join(realHome, `.ak-guard-files-${process.pid}-${Date.now()}`);
  const file = path.join(folder, 'com.avgkeeper.buy.guardtest.plist');
  const s = realSched();
  try {
    assert.throws(() => s.writeFile(file, 'x'), /under the real home directory/);
    assert.equal(fs.existsSync(folder), false, 'not even the folder was made');
    assert.throws(() => s.removeFile(file), /under the real home directory/, 'a missing file under the real home is a refusal, not a quiet ENOENT');
    assert.throws(() => s.writeFile(`${realHome}/Library/../.ak-guard-files-dotdot/x`, 'x'), /under the real home directory/, '.. is resolved before the check');
    assert.equal(fs.existsSync(path.join(realHome, '.ak-guard-files-dotdot')), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(path.join(realHome, '.ak-guard-files-dotdot'), { recursive: true, force: true });
  }
});

test('marker set: a temp folder is still writable, and pointing HOME at it does not open the real home', async () => {
  const tmp = fs.realpathSync(tmpDir('ak-schedfiles-'));
  const s = realSched();
  const file = path.join(tmp, 'Library', 'LaunchAgents', 'a.plist');
  s.writeFile(file, 'x');
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  s.removeFile(file);
  assert.equal(fs.existsSync(file), false);
  const inReal = path.join(realHome, `.ak-guard-files-home-${process.pid}`, 'x');
  try {
    await withEnv({ HOME: tmp }, async () => {
      assert.throws(() => s.writeFile(inReal, 'x'), /under the real home directory/);
    });
  } finally {
    fs.rmSync(path.dirname(inReal), { recursive: true, force: true });
  }
});

test('a symlink in a temp folder that points into the real home is refused too', () => {
  const tmp = fs.realpathSync(tmpDir('ak-schedfiles-'));
  fs.symlinkSync(realHome, path.join(tmp, 'h'));
  assert.match(fileRefusal(path.join(tmp, 'h', '.ak-guard-files-link', 'x'), { AVGKEEPER_TEST_GUARD: '1' }), /under the real home directory/);
});

test('without the marker fileRefusal never refuses (the real user path is untouched)', () => {
  assert.equal(fileRefusal(path.join(realHome, 'Library', 'LaunchAgents', 'x.plist'), {}), null);
});

test('the file refusal reaches install and stop as a FAIL line, never a crash, and nothing is written', async () => {
  const dir = tmpDir('ak-schedfiles-');
  const okx = path.join(dir, 'okx');
  fs.writeFileSync(okx, '#!/bin/sh\n');
  fs.chmodSync(okx, 0o755);
  const ctx = makeCtx({ env: { ...OWNER, AVGKEEPER_OKX_BIN: okx, HOME: dir }, okx: fakeExchange(LOSING) });
  ctx.platform = 'darwin';
  // A folder under the real home that is NOT the real LaunchAgents: if the guard ever broke, the plist would land here
  // (and the finally below removes it), never where launchd loads it at the next login.
  const decoy = path.join(realHome, `.ak-guard-files-install-${process.pid}`);
  ctx.realHome = decoy;
  // The real file functions, the fake launchctl and crontab: no binary can run.
  const real = realSched();
  Object.assign(ctx.sched, { writeFile: real.writeFile, removeFile: real.removeFile, readFile: real.readFile });
  const plist = launchdPlistPath({ profile: 't', demo: false }, decoy);
  try {
    const r = await installSchedule(ctx, { profile: 't', demo: false }, { cadence: 'day', at: '10:00', profile: 't' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /under the real home directory/);
    assert.equal(fs.existsSync(decoy), false, 'nothing was created under the real home');
    ctx.sched.loaded.add('com.avgkeeper.buy.t');
    const s = await removeSchedule(ctx, { profile: 't', demo: false });
    assert.equal(s.ok, true, 'no plist existed, and the loaded job is booted out');
    assert.equal(fs.existsSync(plist), false);
  } finally {
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});

// Lint (2026-09-30 review): a test that spawns a process with an explicit env object drops the guard marker unless it
// names it, and then the child's realSched looks crontab and launchctl up on PATH. Every spawn, spawnSync, execFile,
// execFileSync, exec and execSync call in tests/*.test.mjs that passes env must pass the marker, or spread process.env.
// Static and best effort: an env named by an identifier is checked through the object literals that define it in the
// same file; an env it cannot resolve is a violation too, since nothing proves it.
function skipQuoted(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j += 1;
    else if (q === '`' && src[j] === '$' && src[j + 1] === '{') j = skipBalanced(src, j + 1, '{', '}');
    j += 1;
  }
  return j;
}
function skipBalanced(src, open, o, c) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\'' || ch === '"' || ch === '`') i = skipQuoted(src, i);
    else if (ch === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
    else if (ch === o) depth += 1;
    else if (ch === c) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}
const envOk = (objText) => /AVGKEEPER_TEST_GUARD/.test(objText) || /\bprocess\.env\b/.test(objText);
export function spawnEnvViolations(src) {
  const bad = [];
  let sites = 0;
  const call = /(?<![.\w$])(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/g;
  for (let m = call.exec(src); m; m = call.exec(src)) {
    const open = m.index + m[0].length - 1;
    const args = src.slice(open, skipBalanced(src, open, '(', ')') + 1);
    const line = src.slice(0, m.index).split('\n').length;
    const prop = /[{,]\s*env\s*:\s*/.exec(args);
    const shorthand = /[{,]\s*env\s*[,}]/.exec(args);
    if (!prop && !shorthand) continue;
    sites += 1;
    let values;
    if (prop) {
      const at = prop.index + prop[0].length;
      if (args[at] === '{') values = [args.slice(at, skipBalanced(args, at, '{', '}') + 1)];
      else {
        const id = /^[A-Za-z_$][\w$]*/.exec(args.slice(at));
        values = id ? definitions(src, id[0]) : [];
        if (id && id[0] === 'process') values = ['process.env'];
      }
    } else {
      values = definitions(src, 'env');
    }
    if (!values.length || !values.every(envOk)) bad.push(`line ${line}: ${m[1]} passes an env that does not name AVGKEEPER_TEST_GUARD or spread process.env`);
  }
  return { bad, sites };
}
function definitions(src, id) {
  const out = [];
  const def = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=\\s*\\{`, 'g');
  for (let m = def.exec(src); m; m = def.exec(src)) {
    const open = m.index + m[0].length - 1;
    out.push(src.slice(open, skipBalanced(src, open, '{', '}') + 1));
  }
  return out;
}

test('lint: a spawn with an env object must name the guard marker or spread process.env', () => {
  // Fixtures spell the call names in capitals so this file's own text holds no real call for the lint to read.
  const names = {
    SPAWNSYNC: 'spawnSync', SPAWN: 'spawn', EXECFILE: 'execFile', EXECSYNC: 'execSync',
  };
  const bad = (code) => spawnEnvViolations(code.replace(/\b(SPAWNSYNC|SPAWN|EXECFILE|EXECSYNC)\b/g, (w) => names[w])).bad.length;
  assert.equal(bad("SPAWNSYNC('x', [], { env: { HOME: h }, encoding: 'utf8' });"), 1);
  assert.equal(bad("SPAWNSYNC('x', [], { env: { HOME: h, AVGKEEPER_TEST_GUARD: '1' } });"), 0);
  assert.equal(bad("SPAWNSYNC('x', [], { env: { ...process.env, A: 1 } });"), 0);
  assert.equal(bad("EXECFILE('x', [], { env: process.env });"), 0);
  assert.equal(bad("const env = { HOME: h };\nSPAWN('x', [], { env, encoding: 'utf8' });"), 1);
  assert.equal(bad("const env = { HOME: h, AVGKEEPER_TEST_GUARD: '1' };\nSPAWN('x', [], { env });"), 0);
  assert.equal(bad("const e2 = { HOME: h };\nEXECSYNC('x', { env: e2 });"), 1);
  assert.equal(bad("SPAWNSYNC('x', [], { env: makeEnv() });"), 1, 'an env it cannot resolve is a violation');
  assert.equal(bad("SPAWNSYNC('x', ['a)', \"b'\"], { env: { A: `${x}` } });"), 1, 'quotes and parens inside arguments do not end the call early');
  assert.equal(bad("/x/.exec(line); SPAWNSYNC('x', [], { encoding: 'utf8' }); obj.SPAWN('x', { env: { A: 1 } });"), 0, 'no env, or a method call, is not checked');
});

test('lint: no spawn in tests/*.test.mjs passes an env without the guard marker', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let sites = 0;
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs'))) {
    const r = spawnEnvViolations(fs.readFileSync(path.join(dir, f), 'utf8'));
    sites += r.sites;
    bad.push(...r.bad.map((b) => `${f} ${b}`));
  }
  assert.ok(sites >= 5, `the lint saw only ${sites} spawn sites with an env, so it is checking nothing`);
  assert.deepEqual(bad, []);
});

test('without the marker the bare binary name is used (the real user path)', () => {
  assert.equal(schedBinary('crontab', {}), 'crontab');
  assert.equal(schedBinary('launchctl', { AVGKEEPER_SCHED_BIN_DIR: '/x' }), 'launchctl');
});
