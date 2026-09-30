// avgkeeper/tests/fresh-install.test.mjs
//
// Item 2 of the 2026-09-27 release audit, idea read from GridKeeper's own tests/fresh-install.test.mjs (mechanism
// B, "end-user-path-not-exercised", 2026-09-26 review). Every other test in this suite reads README.md as text
// (tests/interop.test.mjs's own flag checks); none of them ever ran it. This file does: it follows the README's
// own install commands, read from the document itself rather than retyped by hand, into a temp HOME
// (helpers.tmpDir, removed by tests/tmp-guard.mjs), with a stub okx on PATH that wraps
// tests/fixtures/fake-okx.mjs with its spec file path baked into the wrapper script itself, so it answers the same
// way under any environment a later spawn gives it, `env -i` (buy --smoke's own dry-run child) included. No real
// npm, okx, crontab, launchd or network is ever reached.
//
// It then spawns holdings, plan, plan --confirm AVGPLAN, doctor and buy --smoke, in that order, from the copied
// folder, and checks each one's exit code and that none of them ever prints MODULE_NOT_FOUND, ENOENT or
// "command not found": the shapes a path broken by the move to ~/.claude/skills would take. AVGKEEPER_OWNER_TEST=1
// is set on every one of these spawns (the no-owner case further down sets it on none, the way a real user runs),
// the same test-only override this suite's own helpers.mjs uses everywhere
// (OWNER, SCHEDULED): it only ever skips the OKX AI Builder Code guard, and an agent must never set it itself
// (SKILL.md rule 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AK_ROOT, tmpDir } from './helpers.mjs';
import { BUILDER_CODE } from '../scripts/guards.mjs';

const README = fs.readFileSync(path.join(AK_ROOT, 'README.md'), 'utf8');
const FAKE_OKX = fileURLToPath(new URL('./fixtures/fake-okx.mjs', import.meta.url));

// The one backtick-quoted span in the README naming `needle`, read from the document itself: a command retyped
// here by hand could drift from a flag the dispatcher no longer takes, or a path the README no longer gives, and
// nothing would notice, which is the exact gap this file exists to close.
function backtickCommand(text, needle) {
  const spans = text.match(/`[^`]+`/g) || [];
  const found = spans.find((s) => s.includes(needle));
  assert.ok(found, `README.md has no backtick-quoted command naming "${needle}"`);
  return found.slice(1, -1);
}

const MKDIR_CMD = backtickCommand(README, 'mkdir -p');
const COPY_CMD = backtickCommand(README, 'cp -R avgkeeper');
const UPDATE_CMD = backtickCommand(README, 'rm -rf');

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// A newcomer's own profile, one coin (ETH) in loss, enough to carry holdings, a plan card, its confirmation,
// doctor and a dry run through to a real answer rather than an early refusal. Every reply is the bare shape the
// real okx CLI's own JSON envelope carries once runner.mjs's checkEnvelope unwraps it (helpers.mjs's fakeExchange
// answers the same shapes for the in-process double the rest of this suite uses).
const PROFILE = 'newcomer';
const SPEC = {
  '--version': { stdout: '1.4.6\n' },
  'spot place --help': { stdout: '--tgtCcy --aiBuilderCode\n' },
  'config show': { stdout: { profiles: { [PROFILE]: { site: 'global' } } } },
  'account config': { stdout: [{ perm: 'read_only,trade', ip: '1.2.3.4' }] },
  'account balance': {
    stdout: [{
      details: [
        { ccy: 'USDT', eqUsd: '100', availBal: '100', openAvgPx: '', spotUplRatio: '' },
        { ccy: 'ETH', eqUsd: '50', availBal: '0', openAvgPx: '2000', spotUplRatio: '-0.10' },
      ],
    }],
  },
  'market instruments': { stdout: [{ instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.0001', lotSz: '0.00000001' }] },
  'market ticker': { stdout: [{ instId: 'ETH-USDT', last: '1800' }] },
};

// Builds a fresh install: a temp HOME, README's own mkdir and copy commands (steps 1 and 2), and a stub okx on
// PATH. cwd for the copy is the parent of avgkeeper/, the folder a user who cloned or downloaded it would run that
// command from; AK_ROOT is that folder itself (a directory URL, so path.resolve('..') is its parent).
function installFromReadme(specPath) {
  const home = fs.realpathSync(tmpDir('ak-freshhome-'));
  const bin = fs.realpathSync(tmpDir('ak-freshbin-'));
  fs.writeFileSync(
    path.join(bin, 'okx'),
    `#!/bin/sh\nAK_FAKE=${shQuote(specPath)} exec ${shQuote(process.execPath)} ${shQuote(FAKE_OKX)} "$@"\n`,
  );
  fs.chmodSync(path.join(bin, 'okx'), 0o755);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const parent = path.resolve(AK_ROOT, '..');
  const mkdir = spawnSync('/bin/sh', ['-c', MKDIR_CMD], { env, encoding: 'utf8', cwd: home });
  const copy = spawnSync('/bin/sh', ['-c', COPY_CMD], { env, encoding: 'utf8', cwd: parent });
  const entry = path.join(home, '.claude', 'skills', 'avgkeeper', 'scripts', 'avgkeeper.mjs');
  return {
    home, bin, env, parent, mkdir, copy, entry,
  };
}

function run(entry, env, args) {
  return spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8' });
}

// A crash a newcomer would meet as gibberish: a require of a module that is not there, a file the move to
// ~/.claude/skills left behind, a shell that could not find a program. None of AvgKeeper's own screens ever
// produce these; every one of them is a plain English sentence.
function assertClean(r, label) {
  const text = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(text, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ENOENT|command not found/, `${label}: ${text}`);
}

function writeSpec() {
  const specPath = path.join(tmpDir('ak-freshspec-'), 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(SPEC));
  return specPath;
}

test('steps 1 and 2: the README\'s own commands install the skill where Claude Code reads a personal skill from', () => {
  const { mkdir, copy, entry } = installFromReadme(writeSpec());
  assert.equal(mkdir.status, 0, `${mkdir.stdout}${mkdir.stderr}`);
  assert.equal(copy.status, 0, `${copy.stdout}${copy.stderr}`);
  assert.ok(fs.existsSync(entry), `the entry script must exist at the exact path README's own commands put it: ${entry}`);
  const skillFolder = path.dirname(path.dirname(entry));
  assert.ok(fs.existsSync(path.join(skillFolder, 'SKILL.md')), 'SKILL.md must be copied alongside scripts/');
  assert.ok(fs.existsSync(path.join(skillFolder, 'references', 'api-key-setup.md')), 'references/ must be copied too');
});

test('the update line removes the old copy first, so a second install never nests inside it', () => {
  const { env, parent, entry } = installFromReadme(writeSpec());
  assert.ok(fs.existsSync(entry));
  const update = spawnSync('/bin/sh', ['-c', UPDATE_CMD], { env, encoding: 'utf8', cwd: parent });
  assert.equal(update.status, 0, `${update.stdout}${update.stderr}`);
  assert.ok(fs.existsSync(entry), 'the entry script still exists at the same path once the update line finishes');
  const nested = path.join(path.dirname(path.dirname(entry)), 'avgkeeper');
  assert.ok(!fs.existsSync(nested), 'a second install must never nest a copy inside the first one');
});

// AVGKEEPER_OKX_BIN names the stub by its own absolute path, so every call, direct or through the reconstructed
// PATH the printed schedule line and buy --smoke's own inner dry run build for themselves (schedule.mjs's own
// CRON_PATH_TAIL, which also searches the real node binary's own directory), reaches this test's stub rather than
// a real okx CLI a developer's machine happens to have installed in that same directory (this repo's own dev
// machine does, next to its own node binary).
function okxEnv(env, bin) {
  return {
    HOME: env.HOME, PATH: env.PATH, AVGKEEPER_OWNER_TEST: '1', AVGKEEPER_OKX_BIN: path.join(bin, 'okx'),
  };
}

test('holdings, plan, plan --confirm AVGPLAN, doctor and buy --smoke all run end to end from the copied folder', () => {
  const { env, bin, entry } = installFromReadme(writeSpec());
  const call = okxEnv(env, bin);
  const planFlags = ['--profile', PROFILE, '--budget', '10', '--every', 'day', '--method', 'equal'];

  const holdings = run(entry, call, ['holdings', '--profile', PROFILE]);
  assertClean(holdings, 'holdings');
  assert.equal(holdings.status, 0, `${holdings.stdout}${holdings.stderr}`);
  assert.match(holdings.stdout, /ETH/, holdings.stdout);

  const card = run(entry, call, ['plan', ...planFlags]);
  assertClean(card, 'plan');
  assert.equal(card.status, 0, `${card.stdout}${card.stderr}`);
  assert.match(card.stdout, /type AVGPLAN/, card.stdout);

  const confirm = run(entry, call, ['plan', ...planFlags, '--confirm', 'AVGPLAN']);
  assertClean(confirm, 'plan --confirm AVGPLAN');
  assert.equal(confirm.status, 0, `${confirm.stdout}${confirm.stderr}`);
  assert.match(confirm.stdout, /is on\./, confirm.stdout);

  const doctor = run(entry, call, ['doctor', '--profile', PROFILE]);
  assertClean(doctor, 'doctor');
  assert.equal(doctor.status, 0, `${doctor.stdout}${doctor.stderr}`);
  assert.match(doctor.stdout, /Install one of these yourself\./, doctor.stdout);

  const smoke = run(entry, call, ['buy', '--smoke', '--profile', PROFILE]);
  assertClean(smoke, 'buy --smoke');
  assert.equal(smoke.status, 0, `${smoke.stdout}${smoke.stderr}`);
  assert.match(smoke.stdout, /PASS: the cron line doctor prints runs/, smoke.stdout);
});

test('a profile the newcomer never saved in the okx config refuses in plain words, not a crash', () => {
  const { env, bin, entry } = installFromReadme(writeSpec());
  const call = okxEnv(env, bin);
  const r = run(entry, call, ['holdings', '--profile', 'ghost']);
  assertClean(r, 'holdings on an unconfigured profile');
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /REFUSED: profile ghost is not in the okx config\./, r.stdout);
});

// Finding 11 of the 2026-09-27 release-readiness review: every spawn above sets AVGKEEPER_OWNER_TEST=1, so no test
// ran the path a real user takes. This one sets nothing a user would not have. While this build carries no AI
// Builder Code, holdings answers, and every plan, live or demo, refuses in the words the README warns about.
test('without owner test mode, a newcomer meets exactly what the README says a build with no code does', () => {
  assert.equal(BUILDER_CODE, '', 'this build ships with no code; once OKX issues one, rewrite this test and the README section it pins');
  const { env, bin, entry } = installFromReadme(writeSpec());
  const call = { HOME: env.HOME, PATH: env.PATH, AVGKEEPER_OKX_BIN: path.join(bin, 'okx') };
  const planFlags = ['--profile', PROFILE, '--budget', '10', '--every', 'month:15', '--method', 'equal'];
  const holdings = run(entry, call, ['holdings', '--profile', PROFILE]);
  assertClean(holdings, 'holdings');
  assert.equal(holdings.status, 0, `${holdings.stdout}${holdings.stderr}`);
  assert.match(holdings.stdout, /ETH/);
  const refusal = 'REFUSED: this copy of AvgKeeper carries no AI Builder Code from OKX yet, so it buys nothing until an update that carries one.';
  for (const extra of [[], ['--confirm', 'AVGPLAN'], ['--demo'], ['--demo', '--confirm', 'AVGPLAN']]) {
    const r = run(entry, call, ['plan', ...planFlags, ...extra]);
    assertClean(r, `plan ${extra.join(' ')}`);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes(refusal), r.stdout);
    assert.doesNotMatch(r.stdout, /type AVGPLAN|is on\./);
  }
  const doctor = run(entry, call, ['doctor', '--profile', PROFILE]);
  assert.equal(doctor.status, 1, doctor.stdout);
  assert.ok(doctor.stdout.includes('This copy of AvgKeeper carries no code yet, so it buys nothing.'), doctor.stdout);
  const smoke = run(entry, call, ['buy', '--smoke', '--profile', PROFILE]);
  assert.equal(smoke.status, 1, smoke.stdout);
  assert.match(smoke.stdout, /FAIL: no plan yet/);
  assert.ok(README.includes('This build carries no AI Builder Code from OKX yet'), 'the README warns about this before step 1');
});

// Finding 16 of the 2026-09-27 release-readiness review: `cp -R avgkeeper ...` works only from the folder holding
// avgkeeper/, and a reader who opened README.md inside the folder runs it from there. The README now says to step
// out first, with its own `cd ..`, and this follows that from inside the folder.
test('from inside the downloaded folder, the README\'s own cd step then its copy command still install the skill', () => {
  const home = fs.realpathSync(tmpDir('ak-freshhome-'));
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const cdUp = backtickCommand(README, 'cd ..');
  assert.equal(cdUp, 'cd ..');
  const mkdir = spawnSync('/bin/sh', ['-c', MKDIR_CMD], { env, encoding: 'utf8', cwd: home });
  assert.equal(mkdir.status, 0, mkdir.stderr);
  const copy = spawnSync('/bin/sh', ['-c', `${cdUp} && ${COPY_CMD}`], { env, encoding: 'utf8', cwd: AK_ROOT });
  assert.equal(copy.status, 0, `${copy.stdout}${copy.stderr}`);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'avgkeeper', 'scripts', 'avgkeeper.mjs')));
  assert.ok(/From the folder that contains the `avgkeeper` folder/.test(README), 'the README names the folder to run it from');
});
