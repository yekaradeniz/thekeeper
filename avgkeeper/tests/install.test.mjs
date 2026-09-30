// avgkeeper/tests/install.test.mjs
// AVGPLAN installs the schedule, stop removes it, doctor reads it (2026-09-30). Every test here runs on the fake
// ctx.sched from helpers.mjs: an in-memory crontab, in-memory plist files and a launchd that only remembers
// bootstraps. No crontab or launchctl binary and no file under a real home is ever reached.
import {
  makeCtx, fakeSched, fakeExchange, LOSING, OWNER, text, tmpDir,
} from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planVerb } from '../scripts/plan.mjs';
import { stopVerb } from '../scripts/manage.mjs';
import { activePlan } from '../scripts/planview.mjs';
import {
  doctorVerb, installSchedule, withoutEntries, cronMarker, launchdPlistPath, launchdLabel, realSched, runChild, printClass,
} from '../scripts/schedule.mjs';
import { profileNameRefusal } from '../scripts/guards.mjs';
import { scheduleEntryLine } from '../scripts/cards.mjs';
import { makeCtx as realMakeCtx } from '../scripts/avgkeeper.mjs';

const flags = { profile: 't', budget: '10', every: 'day', method: 'equal' };
const LIVE = { profile: 't', demo: false };
const DEMO = { profile: 't', demo: true };

// A real file named okx, so buySchedule can resolve it; the suite's temp guard removes the folder.
function okxEnv() {
  const dir = tmpDir('ak-bin-');
  const p = path.join(dir, 'okx');
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, 0o755);
  return { ...OWNER, AVGKEEPER_OKX_BIN: p, HOME: '/Users/x' };
}

function ctxFor({ platform = 'linux', crontab = null, env = okxEnv() } = {}) {
  const ctx = makeCtx({ env, okx: fakeExchange(LOSING) });
  ctx.platform = platform;
  ctx.sched.crontab = crontab;
  return ctx;
}

async function confirm(ctx, extra = {}) {
  const f = { ...flags, ...extra };
  assert.equal(await planVerb(ctx, f), 0);
  ctx.lines.length = 0;
  const code = await planVerb(ctx, { ...f, confirm: 'AVGPLAN' });
  return code;
}

const cronLines = (ctx) => String(ctx.sched.crontab).split('\n');
const entriesFor = (ctx, o) => withoutEntries(ctx.sched.crontab || '', o).removed;

test('makeCtx wires the fake schedule runner, so no test can reach a real crontab or launchctl', () => {
  const ctx = makeCtx();
  assert.equal(ctx.sched.isFake, true);
  const real = realMakeCtx({ AVGKEEPER_HOME: tmpDir('ak-store-') });
  assert.equal(real.sched.isFake, undefined, 'the entry script wires the real runner');
  assert.notEqual(real.sched.crontabRead, ctx.sched.crontabRead);
  assert.equal(typeof realSched().crontabRead, 'function');
});

test('a context with no sched fails loudly instead of running a real binary', async () => {
  const ctx = ctxFor();
  delete ctx.sched;
  await planVerb(ctx, flags);
  const r = await installSchedule(ctx, LIVE, { cadence: 'day', at: '10:00', profile: 't' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ctx\.sched is not wired/);
});

test('linux: confirm installs into an empty crontab, marker then line, and the receipt says so', async () => {
  const ctx = ctxFor();
  assert.equal(await confirm(ctx), 0);
  const lines = cronLines(ctx);
  assert.equal(lines[0], cronMarker(LIVE));
  assert.match(lines[1], /^0 10 \* \* \* HOME=\/Users\/x PATH=.* buy --profile t >> .*buy-t-live\.log 2>&1$/);
  assert.equal(lines[2], '', 'the text ends with one newline');
  assert.equal(lines.length, 3);
  const t = text(ctx);
  assert.match(t, /^Schedule installed \(crontab, the system scheduler\): AvgKeeper wakes every day at 10:00 machine time\. Output log: .*buy-t-live\.log\.$/m);
  assert.doesNotMatch(t, /ask your agent to run doctor/);
  assert.ok(activePlan(ctx.store.readLedger(), LIVE), 'the plan is on');
});

test('an hourly plan says every hour at :05', async () => {
  const ctx = ctxFor();
  await confirm(ctx, { every: 'hour' });
  assert.match(text(ctx), /^Schedule installed \(crontab, the system scheduler\): AvgKeeper wakes every hour at :05 machine time\. Output log: /m);
  assert.match(cronLines(ctx)[1], /^5 \* \* \* \* /);
});

test('a weekly plan wakes every day and says it buys only on the plan\'s buy days', async () => {
  const ctx = ctxFor();
  await confirm(ctx, { every: 'week:mon' });
  assert.match(text(ctx), /^Schedule installed \(crontab, the system scheduler\): AvgKeeper wakes every day at 10:00 machine time and buys only on the plan's buy days\. Output log: /m);
});

// Item 2 of the 2026-09-30 follow-up: the receipt prints scheduleRisks under its Schedule installed line, the same
// reader doctor uses, so a node or okx path that an upgrade removes is named at install time and in doctor alike.
test('the receipt prints the schedule risks under the Schedule installed line, the same lines doctor prints', async () => {
  const dir = path.join(tmpDir('ak-bin-'), 'v1.2.3');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'okx'), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, 'okx'), 0o755);
  const ctx = ctxFor({ env: { ...OWNER, AVGKEEPER_OKX_BIN: path.join(dir, 'okx'), HOME: '/Users/x' } });
  await confirm(ctx);
  const lines = ctx.lines;
  const at = lines.findIndex((l) => l.startsWith('Schedule installed ('));
  assert.ok(at > -1, text(ctx));
  const risk = lines[at + 1];
  assert.match(risk, /^The schedule names .*v1\.2\.3.*, which has a version number in it: after you upgrade node or the okx CLI, make the plan again with AVGPLAN, which reinstalls the schedule\.$/, text(ctx));
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  assert.ok(ctx.lines.includes(risk), 'doctor prints the very same line');
});

// Item 3: the card is the consent screen, so it says that AVGPLAN changes the computer's own scheduler, naming only
// the platform that applies, before the AVGPLAN invitation.
test('the plan card says AVGPLAN also adds the schedule entry, for the platform it runs on, before the AVGPLAN line', async () => {
  for (const [platform, form] of [['darwin', 'launchd'], ['linux', 'a marked crontab entry']]) {
    const ctx = ctxFor({ platform });
    await planVerb(ctx, flags);
    const want = `Typing AVGPLAN also adds AvgKeeper's own schedule entry on this computer (${form}); stop removes it.`;
    const at = ctx.lines.indexOf(want);
    assert.ok(at > -1, `${platform}: ${text(ctx)}`);
    assert.equal(ctx.lines[at + 1], 'To start it, type AVGPLAN. This card is good for 30 minutes.');
    assert.ok(!text(ctx).includes(platform === 'darwin' ? 'crontab entry' : 'launchd'), platform);
  }
  assert.equal(scheduleEntryLine(null), "Typing AVGPLAN also adds AvgKeeper's own schedule entry on this computer (launchd on macOS, a marked crontab entry on Linux); stop removes it.");
});

test('linux: every other crontab line is kept byte for byte, odd spacing and a missing final newline included', async () => {
  const before = 'MAILTO=me@example.com\n\n# backup job\n  30   2 *  * *   /usr/local/bin/backup.sh --full   \n*/5 * * * * echo "a  b"\t#tab';
  const ctx = ctxFor({ crontab: before });
  await confirm(ctx);
  const lines = cronLines(ctx);
  assert.deepEqual(lines.slice(0, 4), before.split('\n').slice(0, 4));
  assert.equal(lines[4], '*/5 * * * * echo "a  b"\t#tab');
  assert.equal(lines[5], cronMarker(LIVE));
  assert.equal(lines.length, 8);
});

test('a hand-pasted unmarked line for the same profile and mode is replaced, and a hand-written # AvgKeeper comment above it stays', async () => {
  const pasted = '0 9 * * * HOME=/Users/x PATH=/usr/bin:/bin /usr/bin/node /old/scripts/avgkeeper.mjs buy --profile t >> /Users/x/.avgkeeper/buy-t-live.log 2>&1';
  const ctx = ctxFor({ crontab: `# keep me\n# AvgKeeper daily buy\n${pasted}\n0 1 * * * other.sh\n` });
  await confirm(ctx);
  const t = ctx.sched.crontab;
  assert.ok(!t.includes(pasted), 'the pasted line is gone');
  assert.ok(t.startsWith('# keep me\n# AvgKeeper daily buy\n0 1 * * * other.sh\n'), `the comment is the user's and stays: ${t}`);
  assert.equal(entriesFor(ctx, LIVE), 1, 'a marker and its line count as one entry');
  assert.equal(t.split('\n').filter((l) => l.includes('avgkeeper.mjs buy')).length, 1);
});

test('a second confirm replaces the first entry instead of adding a second', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  await confirm(ctx, { at: '11:30' });
  const buys = cronLines(ctx).filter((l) => l.includes('avgkeeper.mjs buy'));
  assert.equal(buys.length, 1);
  assert.match(buys[0], /^30 11 \* \* \* /);
  assert.equal(cronLines(ctx).filter((l) => l === cronMarker(LIVE)).length, 1);
});

test('another profile, and the other mode of the same profile, survive; demo and live are distinct', async () => {
  const other = '0 9 * * * /usr/bin/node /x/scripts/avgkeeper.mjs buy --profile t2 >> /l 2>&1';
  const otherMarked = `${cronMarker({ profile: 't2', demo: false })}\n${other}`;
  const demoLine = '0 9 * * * /usr/bin/node /x/scripts/avgkeeper.mjs buy --profile t --demo >> /l 2>&1';
  const ctx = ctxFor({ crontab: `${otherMarked}\n${cronMarker(DEMO)}\n${demoLine}\n` });
  await confirm(ctx);
  assert.ok(ctx.sched.crontab.includes(other), 'profile t2 is untouched');
  assert.ok(ctx.sched.crontab.includes(demoLine), 'the demo entry of the same profile is untouched');
  assert.equal(entriesFor(ctx, LIVE), 1, 'live has its own marker and line');
  // Installing the demo plan next replaces the demo entry only.
  const demoCtx = ctxFor({ crontab: ctx.sched.crontab, env: ctx.env });
  await confirm(demoCtx, { demo: true });
  const buys = cronLines(demoCtx).filter((l) => l.includes('avgkeeper.mjs buy'));
  assert.equal(buys.filter((l) => l.includes('--demo')).length, 1);
  assert.ok(!demoCtx.sched.crontab.includes(demoLine), 'the old demo line is replaced');
  assert.equal(buys.filter((l) => l.includes('--profile t ') && !l.includes('--demo')).length, 1, 'the live entry survives');
  assert.ok(demoCtx.sched.crontab.includes(other));
});

test('profile names are matched as whole words: t does not match t2', () => {
  const t2 = '0 9 * * * node /x/avgkeeper.mjs buy --profile t2 >> /l 2>&1';
  assert.equal(withoutEntries(`${t2}\n`, LIVE).removed, 0);
  assert.equal(withoutEntries('0 9 * * * node /x/avgkeeper.mjs buy --profile t >> /l 2>&1\n', LIVE).removed, 1);
  assert.equal(withoutEntries('0 9 * * * node /x/avgkeeper.mjs buy --profile t >> /l 2>&1\n', DEMO).removed, 0);
  assert.equal(withoutEntries('# 0 9 * * * node /x/avgkeeper.mjs buy --profile t\n', LIVE).removed, 0, 'a commented-out line is not an entry');
});

test('only a script whose basename is exactly avgkeeper.mjs is ours: myavgkeeper.mjs is another program', () => {
  const line = (script) => `0 9 * * * node ${script} buy --profile t >> /l 2>&1\n`;
  assert.equal(withoutEntries(line('/x/myavgkeeper.mjs'), LIVE).removed, 0);
  assert.equal(withoutEntries(line('/x/avgkeeper.mjs.bak'), LIVE).removed, 0);
  assert.equal(withoutEntries(line('avgkeeper.mjs'), LIVE).removed, 1, 'a bare script name in the current folder');
  assert.equal(withoutEntries(line('/x/avgkeeper.mjs'), LIVE).removed, 1);
  assert.equal(withoutEntries(line("'/a b/scripts/avgkeeper.mjs'"), LIVE).removed, 1, 'a quoted path with a space');
});

test('runChild keeps a multi-byte character whole when the child writes its bytes in two separate reads', async () => {
  // U+015F (the Turkish s with a cedilla) is the bytes C5 9F. Written 80 ms apart, they arrive as two chunks.
  const child = "const w = (b) => process.stdout.write(Buffer.from(b)); w([0x23, 0x20, 0xc5]); setTimeout(() => { w([0x9f, 0x0a]); process.stderr.write(Buffer.from([0xc5])); setTimeout(() => process.stderr.write(Buffer.from([0x9f])), 80); }, 80);";
  const r = await runChild(process.execPath, ['-e', child]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '# ş\n');
  assert.equal(r.stderr, 'ş');
});

test('a profile name ending in .demo is refused at the card and at confirm: its launchd label would be another profile\'s demo label', async () => {
  assert.equal(launchdLabel({ profile: 'x', demo: true }), launchdLabel({ profile: 'x.demo', demo: false }), 'the collision this refusal exists for');
  for (const name of ['x.demo', 'X.DEMO', 'x.Demo']) {
    const ctx = ctxFor({ platform: 'darwin' });
    assert.equal(await planVerb(ctx, { ...flags, profile: name }), 1);
    assert.match(text(ctx), /^REFUSED: a plan cannot use profile name \S+, because a name ending in \.demo gets the same launchd schedule name as /m, text(ctx));
    assert.equal(await planVerb(ctx, { ...flags, profile: name, confirm: 'AVGPLAN' }), 1);
    assert.deepEqual(ctx.store.readLedger().map((e) => e.kind), [], 'no card and no plan was written');
    assert.equal(ctx.sched.calls.length, 0, 'nothing was installed');
    assert.equal(profileNameRefusal(name).startsWith('REFUSED: '), true);
  }
  for (const name of ['x.demos', 'xdemo', 'demo.x', 'x-demo']) {
    assert.equal(profileNameRefusal(name), null, name);
  }
});

test('a crontab write failure prints the FAIL receipt and the plan stays on', async () => {
  const ctx = ctxFor({ crontab: '0 1 * * * other.sh\n' });
  ctx.sched.crontabWriteFails = 1;
  assert.equal(await confirm(ctx), 1, 'a plan with no schedule exits 1');
  const t = text(ctx);
  assert.match(t, /^FAIL: the plan is on, but AvgKeeper could not install its schedule \(crontab write exited 1: crontab: cannot write\)\. Nothing buys until a schedule exists\. Ask your agent for doctor, which prints the line to install yourself\.$/m);
  assert.ok(!t.includes('Schedule installed'));
  assert.ok(activePlan(ctx.store.readLedger(), LIVE), 'the plan is still on');
  assert.equal(ctx.sched.crontab, '0 1 * * * other.sh\n', 'the user crontab is unchanged');
});

test('an unreadable crontab is never treated as empty: nothing is written', async () => {
  const ctx = ctxFor({ crontab: 'keep\n' });
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /FAIL: the plan is on, but AvgKeeper could not install its schedule \(crontab -l exited 2: crontab: permission denied\)/);
  assert.equal(ctx.sched.calls.filter((c) => c.args[0] === '-').length, 0, 'no write was attempted');
  assert.ok(activePlan(ctx.store.readLedger(), LIVE));
});

test('no okx to name in the schedule is a FAIL receipt, not a crash', async () => {
  const ctx = ctxFor({ env: { ...OWNER, PATH: '/nonexistent' } });
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /^FAIL: the plan is on, but AvgKeeper could not install its schedule \(no okx on PATH/m);
  assert.equal(ctx.sched.calls.length, 0);
});

test('macOS: confirm writes the plist, boots out, then bootstraps, and reads it back', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  const plist = launchdPlistPath(LIVE, ctx.realHome);
  const saved = ctx.sched.files.get(plist);
  assert.ok(saved && saved.includes('<string>com.avgkeeper.buy.t</string>'), 'the plist is saved');
  const launch = ctx.sched.calls.filter((c) => c.cmd === 'launchctl').map((c) => c.args);
  assert.deepEqual(launch.slice(0, 2), [['bootout', 'gui/501/com.avgkeeper.buy.t'], ['bootstrap', 'gui/501', plist]]);
  assert.deepEqual(launch[2], ['print', 'gui/501/com.avgkeeper.buy.t']);
  assert.match(text(ctx), /^Schedule installed \(launchd, macOS's own scheduler\): AvgKeeper wakes every day at 10:00 machine time\. Output log: .*buy-t-live\.log\.$/m);
});

test('macOS: a hand-pasted crontab entry for the same profile is removed so launchd is the only scheduler', async () => {
  const pasted = '0 9 * * * /usr/bin/node /x/scripts/avgkeeper.mjs buy --profile t >> /l 2>&1';
  const ctx = ctxFor({ platform: 'darwin', crontab: `0 1 * * * other.sh\n# AvgKeeper\n${pasted}\n` });
  await confirm(ctx);
  assert.equal(ctx.sched.crontab, '0 1 * * * other.sh\n# AvgKeeper\n');
  assert.match(text(ctx), /Schedule installed \(launchd, macOS's own scheduler\)/);
});

test('macOS: a failed bootstrap is a FAIL receipt and the plan stays on', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  ctx.sched.bootstrapFails = 5;
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /^FAIL: the plan is on, but AvgKeeper could not install its schedule \(launchctl bootstrap exited 5: Bootstrap failed: 5: Input\/output error\)\. Nothing buys until a schedule exists\. Ask your agent for doctor, which prints the line to install yourself\.$/m);
  assert.ok(activePlan(ctx.store.readLedger(), LIVE));
  // Item 1: the plist written for the failed bootstrap is deleted and launchd is asked to boot the job out, so
  // nothing loads at the next login.
  const plist = launchdPlistPath(LIVE, ctx.realHome);
  assert.equal(ctx.sched.files.has(plist), false, 'no live plist is left behind');
  const launch = ctx.sched.calls.filter((c) => c.cmd === 'launchctl').map((c) => c.args[0]);
  assert.deepEqual(launch, ['bootout', 'bootstrap', 'bootout', 'print'], 'cleanup boots out, then checks launchd');
  assert.doesNotMatch(text(ctx), /may be left/);
});

test('stop removes the launchd job and plist, and says so', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  const plist = launchdPlistPath(LIVE, ctx.realHome);
  ctx.lines.length = 0;
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.equal(ctx.sched.files.has(plist), false);
  assert.equal(ctx.sched.loaded.size, 0);
  assert.match(text(ctx), /^Schedule removed\.$/m);
  assert.doesNotMatch(text(ctx), /To take it out/);
});

test('stop removes only this profile and mode from the crontab, every other line kept', async () => {
  const ctx = ctxFor({ crontab: '0 1 * * * other.sh\n' });
  await confirm(ctx);
  const t2 = '0 9 * * * /usr/bin/node /x/scripts/avgkeeper.mjs buy --profile t2 >> /l 2>&1';
  ctx.sched.crontab += `${t2}\n`;
  ctx.lines.length = 0;
  assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
  assert.equal(ctx.sched.crontab, `0 1 * * * other.sh\n${t2}\n`);
  assert.match(text(ctx), /^Schedule removed\.$/m);
});

test('stop with nothing installed says so and does not claim a removal', async () => {
  const ctx = ctxFor({ env: { ...OWNER, PATH: '/nonexistent' } });
  await confirm(ctx);
  ctx.lines.length = 0;
  await stopVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /No AvgKeeper schedule entry was found for this profile, so there was nothing to remove\./);
  assert.doesNotMatch(text(ctx), /Schedule removed/);
});

test('doctor: installed and matching prints the installed line and no install instructions', async () => {
  for (const platform of ['linux', 'darwin']) {
    const ctx = ctxFor({ platform });
    await confirm(ctx);
    ctx.lines.length = 0;
    assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
    const t = text(ctx);
    assert.match(t, new RegExp(`^Schedule: installed \\(${platform === 'darwin' ? "launchd, macOS's own scheduler" : 'crontab, the system scheduler'}\\)\\. AvgKeeper wakes every day at 10:00 machine time\\.`, 'm'), t);
    assert.match(t, /buy --smoke/);
    assert.doesNotMatch(t, /Install one of these yourself|Option 1|Or ask your agent to make the plan again/);
  }
});

test('doctor: nothing installed keeps the manual instructions and names AVGPLAN', async () => {
  const ctx = ctxFor({ env: okxEnv() });
  await confirm(ctx);
  ctx.sched = fakeSched();
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /Install one of these yourself\./);
  assert.match(t, /^Or ask your agent to make the plan again with AVGPLAN, which installs it\.$/m);
  assert.match(t, /Option 1, crontab/);
});

test('doctor: an entry that differs from the plan is reported as different and never rewritten', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  ctx.sched.crontab = ctx.sched.crontab.replace('0 10 * * *', '0 7 * * *');
  const before = ctx.sched.crontab;
  ctx.sched.calls.length = 0;
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /^Schedule: an entry is installed \(crontab, the system scheduler\) but it differs from this plan\. Make the plan again with AVGPLAN, which replaces it\.$/m);
  assert.match(t, /Install one of these yourself\./);
  assert.match(t, /^Option 1, crontab .* Run crontab -e, delete the old AvgKeeper lines \(the "# avgkeeper" comment and the line under it\), then add this line:$/m);
  assert.equal(ctx.sched.crontab, before);
  assert.equal(ctx.sched.calls.filter((c) => c.args[0] === '-').length, 0, 'doctor never writes');
});

// ---------------------------------------------------------------------------------------------------------------
// Review round of 2026-09-30: a failed install leaves nothing live, the exit code says so, launchctl answers are
// classified, the crontab is read on both platforms, and the two stop sentences never contradict.
// ---------------------------------------------------------------------------------------------------------------
const PLIST = launchdPlistPath(LIVE, '/Users/test');
const launchCalls = (ctx) => ctx.sched.calls.filter((c) => c.cmd === 'launchctl').map((c) => c.args);
const OK = { code: 0, stdout: '', stderr: '' };
// Wraps ctx.sched.launchctl: fn(args) answers a result to override a call, or undefined to let the fake answer.
function overrideLaunchctl(ctx, fn) {
  const orig = ctx.sched.launchctl;
  ctx.sched.launchctl = async (args) => {
    const r = fn(args);
    if (r === undefined) return orig(args);
    ctx.sched.calls.push({ cmd: 'launchctl', args });
    return r;
  };
}

test('printClass: only exit 0 is loaded, only "not found" is not loaded, everything else is unknown', () => {
  assert.equal(printClass({ code: 0, stderr: '' }), 'loaded');
  assert.equal(printClass({ code: 113, stderr: '' }), 'notloaded');
  assert.equal(printClass({ code: 1, stderr: 'Could not find service "x" in domain for user gui: 501' }), 'notloaded');
  assert.equal(printClass({ code: null, stderr: '', timedOut: true }), 'unknown');
  assert.equal(printClass({ code: null, stderr: 'Could not find service', timedOut: true }), 'unknown', 'a timeout is unknown whatever it printed');
  assert.equal(printClass({ code: 126, stderr: 'permission denied' }), 'unknown');
  assert.equal(printClass({ code: 5, stderr: 'Input/output error' }), 'unknown');
  assert.equal(printClass({ code: 127, stderr: 'not found' }), 'unknown');
});

test('macOS: launchd says OK to the bootstrap but does not show the job: boot it out, delete the plist, say nothing is left', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  overrideLaunchctl(ctx, (args) => (args[0] === 'bootstrap' ? OK : undefined));
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /^FAIL: the plan is on, but AvgKeeper could not install its schedule \(launchd did not show the job after loading it \(the plist is saved but launchd has not loaded it\)\)\. Nothing buys until a schedule exists\. Ask your agent for doctor, which prints the line to install yourself\.$/m);
  assert.equal(ctx.sched.files.has(PLIST), false, 'the plist is deleted');
  const verbs = launchCalls(ctx).map((a) => a[0]);
  assert.deepEqual(verbs.slice(-2), ['bootout', 'print'], 'cleanup ends with a boot out and a look');
  assert.ok(verbs.indexOf('bootstrap') < verbs.lastIndexOf('bootout'), 'the boot out came after the bootstrap');
  assert.ok(activePlan(ctx.store.readLedger(), LIVE), 'the plan stays on');
  assert.ok(!text(ctx).includes('Schedule installed'));
});

test('macOS: a failed install whose cleanup also fails says an entry may be left, and where', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  ctx.sched.bootstrapFails = 5;
  ctx.sched.removeFile = () => { throw new Error('EACCES: permission denied'); };
  assert.equal(await confirm(ctx), 1);
  const t = text(ctx);
  assert.match(t, /^FAIL: the plan is on, but AvgKeeper could not install its schedule \(launchctl bootstrap exited 5: .*\), and it could not take its own partial work back, so an entry may be left in launchd \(plist \/Users\/test\/Library\/LaunchAgents\/com\.avgkeeper\.buy\.t\.plist, job com\.avgkeeper\.buy\.t\)\. Ask your agent for doctor, which shows what is installed and how to take it out\.$/m, t);
  assert.ok(!t.includes('Nothing buys until a schedule exists'), 'it does not claim nothing is installed');
  assert.ok(ctx.sched.files.has(PLIST), 'the plist really is still there');
});

test('macOS: a failed install where launchd cannot confirm the job is gone says an entry may be left', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  overrideLaunchctl(ctx, (args) => (args[0] === 'print' ? { code: 126, stdout: '', stderr: 'launchctl: cannot execute\n' } : undefined));
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /launchd did not show the job after loading it \(the plist is saved, but launchd could not say whether it is loaded \(launchctl print exited 126: launchctl: cannot execute\)\)\), and it could not take its own partial work back, so an entry may be left in launchd \(plist /);
  assert.equal(ctx.sched.files.has(PLIST), false, 'the plist was still deleted');
});

test('linux: a good write the crontab does not show is written back without our entry', async () => {
  const ctx = ctxFor({ crontab: 'keep\n' });
  const orig = ctx.sched.crontabWrite;
  let n = 0;
  ctx.sched.crontabWrite = async (input) => {
    n += 1;
    if (n === 1) {
      ctx.sched.calls.push({ cmd: 'crontab', args: ['-'], input });
      return OK;
    }
    return orig(input);
  };
  assert.equal(await confirm(ctx), 1);
  assert.equal(n, 2, 'a second write took the entry back');
  assert.equal(ctx.sched.crontab, 'keep\n', 'the user crontab is exactly as it was');
  assert.match(text(ctx), /^FAIL: the plan is on, but AvgKeeper could not install its schedule \(the crontab did not show the entry after writing it \(missing\)\)\. Nothing buys until a schedule exists\./m);
});

test('linux: a write the crontab does not show and cannot be taken back says an entry may be left in the crontab', async () => {
  const ctx = ctxFor({ crontab: 'keep\n' });
  let n = 0;
  ctx.sched.crontabWrite = async (input) => {
    n += 1;
    ctx.sched.calls.push({ cmd: 'crontab', args: ['-'], input });
    return n === 1 ? OK : { code: 1, stdout: '', stderr: 'crontab: cannot write\n' };
  };
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /and it could not take its own partial work back, so an entry may be left in your crontab\. Ask your agent for doctor, which shows what is installed and how to take it out\.$/m);
  assert.doesNotMatch(text(ctx), /Nothing buys until a schedule exists/);
});

test('a confirm whose install worked exits 0 and one whose install failed exits 1, with the ledger identical', async () => {
  const good = ctxFor();
  assert.equal(await confirm(good), 0);
  const bad = ctxFor();
  bad.sched.crontabWriteFails = 1;
  assert.equal(await confirm(bad), 1);
  const kindsOf = (c) => c.store.readLedger().map((e) => e.kind);
  assert.deepEqual(kindsOf(bad), kindsOf(good), 'a failed install never un-confirms or adds a ledger line');
});

test('macOS: an unreadable crontab still installs launchd, and the receipt warns that the old-line check was not made', async () => {
  const ctx = ctxFor({ platform: 'darwin', crontab: 'keep\n' });
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  assert.equal(await confirm(ctx), 0);
  const t = text(ctx);
  assert.match(t, /^Schedule installed \(launchd, macOS's own scheduler\): /m);
  assert.match(t, /^WARNING: AvgKeeper could not read your crontab \(crontab -l exited 2: crontab: permission denied\), so it could not check it for an old AvgKeeper line\./m);
  assert.ok(ctx.sched.files.has(PLIST));
  assert.equal(ctx.sched.calls.filter((c) => c.cmd === 'crontab' && c.args[0] === '-').length, 0, 'the crontab is never written from a read that failed');
});

test('macOS: a readable crontab prints no crontab warning', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  assert.equal(await confirm(ctx), 0);
  assert.doesNotMatch(text(ctx), /WARNING/);
});

test('macOS: an old crontab entry that cannot be removed stops the install before any plist is written', async () => {
  const pasted = '0 9 * * * /usr/bin/node /x/scripts/avgkeeper.mjs buy --profile t >> /l 2>&1';
  const ctx = ctxFor({ platform: 'darwin', crontab: `${pasted}\n` });
  ctx.sched.crontabWriteFails = 1;
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /an AvgKeeper crontab entry for this profile would run next to launchd, and it could not be removed \(crontab write exited 1/);
  assert.equal(ctx.sched.files.size, 0, 'no plist was written');
  assert.equal(launchCalls(ctx).length, 0);
});

test('a crontab that exits 1 with any message but "no crontab" is unreadable, never empty', async () => {
  const ctx = ctxFor({ crontab: 'keep\n' });
  ctx.sched.crontabRead = async () => ({ code: 1, stdout: '', stderr: 'crontab: permission denied\n' });
  assert.equal(await confirm(ctx), 1);
  assert.match(text(ctx), /\(crontab -l exited 1: crontab: permission denied\)/);
  assert.equal(ctx.sched.calls.filter((c) => c.cmd === 'crontab' && c.args[0] === '-').length, 0);
});

test('stop: launchd answering print with a timeout, 126 or any other code is unknown, never "Schedule removed."', async () => {
  const answers = [
    [{ code: null, stdout: '', stderr: '', timedOut: true }, /launchctl print exited without a code: it did not finish in time/],
    [{ code: 126, stdout: '', stderr: 'cannot execute\n' }, /launchctl print exited 126: cannot execute/],
    [{ code: 5, stdout: '', stderr: 'Input\/output error\n' }, /launchctl print exited 5: Input\/output error/],
  ];
  for (const [answer, why] of answers) {
    const ctx = ctxFor({ platform: 'darwin' });
    await confirm(ctx);
    ctx.lines.length = 0;
    overrideLaunchctl(ctx, (args) => (args[0] === 'print' ? answer : undefined));
    assert.equal(await stopVerb(ctx, { profile: 't' }), 0);
    const t = text(ctx);
    assert.match(t, /^The schedule could not be removed \(launchd could not say whether the job is still loaded after bootout \(/m, t);
    assert.match(t, why);
    assert.match(t, /so an installed entry may still fire and now buys nothing\. To take it out:/);
    assert.match(t, /If you used launchd, run both: launchctl bootout gui\/\$\(id -u\)\/com\.avgkeeper\.buy\.t, then rm /);
    assert.doesNotMatch(t, /Schedule removed/);
    assert.equal(ctx.sched.files.has(PLIST), true, 'nothing is deleted on a guess');
  }
});

test('stop: launchd saying the service is not found (exit 113, or the words on another code) is a clean removal', async () => {
  for (const answer of [{ code: 113, stdout: '', stderr: '' }, { code: 1, stdout: '', stderr: 'Could not find service "com.avgkeeper.buy.t" in domain for user gui: 501\n' }]) {
    const ctx = ctxFor({ platform: 'darwin' });
    await confirm(ctx);
    ctx.lines.length = 0;
    overrideLaunchctl(ctx, (args) => (args[0] === 'print' ? answer : undefined));
    await stopVerb(ctx, { profile: 't' });
    assert.match(text(ctx), /^Schedule removed\.$/m);
    assert.equal(ctx.sched.files.has(PLIST), false);
  }
});

test('stop: a bootout that fails while the job is still loaded is a failure, and the plist stays', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  ctx.lines.length = 0;
  overrideLaunchctl(ctx, (args) => (args[0] === 'bootout' ? { code: 5, stdout: '', stderr: 'Boot-out failed: 5: Input/output error\n' } : undefined));
  await stopVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /^The schedule could not be removed \(launchd still has the job loaded after bootout \(/m);
  assert.doesNotMatch(text(ctx), /Schedule removed/);
  assert.equal(ctx.sched.files.has(PLIST), true);
});

test('stop: a bootout that exits 0 is a removal even when no plist file was on disk', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  ctx.sched.files.delete(PLIST);
  assert.ok(ctx.sched.loaded.has('com.avgkeeper.buy.t'), 'the job is still loaded');
  ctx.lines.length = 0;
  await stopVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /^Schedule removed\.$/m);
  assert.doesNotMatch(text(ctx), /nothing to remove/);
  assert.equal(ctx.sched.loaded.size, 0);
  // Item 4 (2026-09-30 review): booted out by label, so a job whose plist is gone can still be unloaded.
  assert.deepEqual(launchCalls(ctx).find((a) => a[0] === 'bootout'), ['bootout', 'gui/501/com.avgkeeper.buy.t']);
});

test('stop on macOS: an unreadable crontab is a removal failure with the manual lines, never "nothing to remove"', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  ctx.lines.length = 0;
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  await stopVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /^The schedule could not be removed \(the launchd job was taken out, but the crontab could not be read to look for an AvgKeeper line \(crontab -l exited 2: crontab: permission denied\)\), so an installed entry may still fire/m, t);
  assert.match(t, /If you used crontab, delete the AvgKeeper lines from your crontab yourself \(crontab -e\): the "# avgkeeper" comment and the line under it/);
  assert.doesNotMatch(t, /nothing to remove|Schedule removed/);
  assert.equal(ctx.sched.files.has(PLIST), false, 'the launchd half was removed');
});

test('stop on macOS with nothing installed and an unreadable crontab is still a failure, worded without a launchd removal', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  await stopVerb(ctx, { profile: 't' });
  // A second stop: nothing in launchd now, and the crontab cannot be read.
  ctx.lines.length = 0;
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  await stopVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /^The schedule could not be removed \(the crontab could not be read to look for an AvgKeeper line \(/m, t);
  assert.doesNotMatch(t, /Nothing changed|nothing to remove/);
});

test('stop on linux: an unreadable crontab is a removal failure and nothing is written', async () => {
  const ctx = ctxFor({ crontab: 'keep\n' });
  await confirm(ctx);
  const before = ctx.sched.crontab;
  ctx.lines.length = 0;
  ctx.sched.calls.length = 0;
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  await stopVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /^The schedule could not be removed \(crontab -l exited 2: crontab: permission denied\), so an installed entry may still fire and now buys nothing\. To take it out:$/m, t);
  assert.doesNotMatch(t, /nothing to remove|Schedule removed/);
  assert.equal(ctx.sched.crontab, before);
  assert.equal(ctx.sched.calls.filter((c) => c.args[0] === '-').length, 0);
});

test('doctor: a launchd answer that is neither loaded nor not found says it could not tell, not installed and not missing', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  ctx.lines.length = 0;
  overrideLaunchctl(ctx, (args) => (args[0] === 'print' ? { code: 126, stdout: '', stderr: 'cannot execute\n' } : undefined));
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /Schedule: AvgKeeper wakes every day at 10:00 machine time\. AvgKeeper could not tell whether an entry is installed \(the plist is saved, but launchd could not say whether it is loaded \(launchctl print exited 126: cannot execute\)\)\. If none is, install one of these yourself\./);
  assert.doesNotMatch(t, /Schedule: installed/);
});

test('doctor on linux: an unreadable crontab says it could not tell', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  ctx.lines.length = 0;
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  await doctorVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /AvgKeeper could not tell whether an entry is installed \(crontab -l exited 2: crontab: permission denied\)\. If none is, install one of these yourself\./);
  assert.doesNotMatch(text(ctx), /Schedule: installed/);
});

test('doctor on macOS: a saved plist that differs is "different", and one launchd has not loaded is not installed', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  ctx.sched.files.set(PLIST, ctx.sched.files.get(PLIST).replace('<integer>10</integer>', '<integer>7</integer>'));
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /^Schedule: an entry is installed \(launchd, macOS's own scheduler\) but it differs from this plan\. Make the plan again with AVGPLAN, which replaces it\.$/m);
  assert.match(text(ctx), /Install one of these yourself\./);
  const unloaded = ctxFor({ platform: 'darwin' });
  await confirm(unloaded);
  unloaded.sched.loaded.clear();
  unloaded.lines.length = 0;
  await doctorVerb(unloaded, { profile: 't' });
  assert.doesNotMatch(text(unloaded), /Schedule: installed/);
  assert.match(text(unloaded), /Install one of these yourself\./);
});

test('doctor on macOS: a crontab entry left for the same profile and mode is a problem next to an installed job', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  ctx.sched.crontab = '0 9 * * * /usr/bin/node /x/scripts/avgkeeper.mjs buy --profile t >> /l 2>&1\n';
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 1);
  const t = text(ctx);
  assert.match(t, /^Schedule: installed \(launchd, macOS's own scheduler\)\. /m);
  assert.match(t, /^FAIL: your crontab also holds an AvgKeeper buy line for this profile, so a second scheduler runs this plan next to launchd\./m, t);
  assert.match(t, /delete it yourself with crontab -e \(the "# avgkeeper" comment and the line under it\)\./, t);
  // The demo entry of the same profile and another profile's entry are not ours to report.
  const other = ctxFor({ platform: 'darwin' });
  await confirm(other);
  other.sched.crontab = '0 9 * * * node /x/avgkeeper.mjs buy --profile t --demo\n0 9 * * * node /x/avgkeeper.mjs buy --profile t2\n';
  other.lines.length = 0;
  assert.equal(await doctorVerb(other, { profile: 't' }), 0);
  assert.doesNotMatch(text(other), /FAIL/);
});

test('doctor on macOS: an unreadable crontab next to an installed job reports nothing it did not see', async () => {
  const ctx = ctxFor({ platform: 'darwin' });
  await confirm(ctx);
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  assert.match(text(ctx), /^Schedule: installed \(launchd, macOS's own scheduler\)\. /m);
  assert.doesNotMatch(text(ctx), /FAIL/);
});

test('doctor on linux: more than one AvgKeeper entry for this profile and mode is a problem', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  ctx.sched.crontab += '0 9 * * * node /x/scripts/avgkeeper.mjs buy --profile t >> /l 2>&1\n';
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /^FAIL: your crontab holds 2 AvgKeeper buy lines for this profile, so the buy is scheduled 2 times\./m, text(ctx));
  assert.match(text(ctx), /^Schedule: installed \(crontab, the system scheduler\)\. /m);
});

test('doctor on linux: the plan\'s exact line with no marker above it reads as installed by hand, not different', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  ctx.sched.crontab = ctx.sched.crontab.split('\n').filter((l) => l !== cronMarker(LIVE)).join('\n');
  assert.ok(!ctx.sched.crontab.includes('# avgkeeper'), 'the marker is gone');
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /^Schedule: installed \(crontab, the system scheduler; this crontab line was added by hand, not by AVGPLAN\)\. AvgKeeper wakes every day at 10:00 machine time\./m, t);
  assert.doesNotMatch(t, /differs from this plan|Install one of these yourself/);
});

// Item 2 (2026-09-30 review): a crontab that is not valid UTF-8 (here a Latin-1 comment, bytes 23 20 67 e9 6e 0a) decodes
// to U+FFFD, and writing that text back would replace the user's own bytes. It is unreadable, never rewritten. The bytes
// come from a real child process through runChild, so the test covers the decoding too.
const LATIN1_BYTES = '[0x23, 0x20, 0x67, 0xe9, 0x6e, 0x0a]';
const UNSAFE_REASON = 'your crontab contains characters AvgKeeper cannot read back safely, so it did not change it';
const latin1Read = () => runChild(process.execPath, ['-e', `process.stdout.write(Buffer.from(${LATIN1_BYTES}))`], { timeoutMs: 10000 });

test('a crontab with bytes that are not UTF-8 makes the install FAIL and is never written back', async () => {
  const ctx = ctxFor({ crontab: 'keep\n' });
  ctx.sched.crontabRead = latin1Read;
  assert.equal(await confirm(ctx), 1);
  assert.ok(text(ctx).includes(`(${UNSAFE_REASON})`), text(ctx));
  assert.equal(ctx.sched.calls.filter((c) => c.cmd === 'crontab' && c.args[0] === '-').length, 0, 'no write');
  assert.equal(ctx.sched.crontab, 'keep\n');
});

test('stop: a crontab with bytes that are not UTF-8 is a removal failure with the manual lines, nothing written', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  ctx.lines.length = 0;
  ctx.sched.calls.length = 0;
  ctx.sched.crontabRead = latin1Read;
  await stopVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.ok(t.includes(`The schedule could not be removed (${UNSAFE_REASON})`), t);
  assert.match(t, /If you used crontab, delete the AvgKeeper lines/);
  assert.doesNotMatch(t, /Schedule removed/);
  assert.equal(ctx.sched.calls.filter((c) => c.cmd === 'crontab' && c.args[0] === '-').length, 0, 'no write');
});

test('doctor: a crontab with bytes that are not UTF-8 is "could not read", never missing or installed', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  ctx.lines.length = 0;
  ctx.sched.crontabRead = latin1Read;
  await doctorVerb(ctx, { profile: 't' });
  assert.ok(text(ctx).includes(`could not tell whether an entry is installed (${UNSAFE_REASON})`), text(ctx));
  assert.doesNotMatch(text(ctx), /Schedule: installed/);
});

// Item 1 (2026-09-30 review): "Nothing buys until a schedule exists" is only true when the code saw no earlier entry and
// left nothing. A failure before an earlier entry was touched, with that entry seen or unlooked-for, says it may still run.
const MAY_REMAIN = 'An earlier AvgKeeper schedule entry may still be installed and would run this plan at its own time. Ask your agent for doctor, which shows what is installed and how to take it out.';
const PASTED = '0 9 * * * /usr/bin/node /x/scripts/avgkeeper.mjs buy --profile t >> /l 2>&1';

test('macOS: an old crontab line that cannot be removed says it may still run, never "Nothing buys"', async () => {
  const ctx = ctxFor({ platform: 'darwin', crontab: `${PASTED}\n` });
  ctx.sched.crontabWriteFails = 1;
  assert.equal(await confirm(ctx), 1);
  assert.ok(text(ctx).includes(MAY_REMAIN), text(ctx));
  assert.ok(!text(ctx).includes('Nothing buys until a schedule exists'));
});

test('linux: a crontab write that fails with an AvgKeeper line seen says it may still run', async () => {
  const ctx = ctxFor({ crontab: `${PASTED}\n` });
  ctx.sched.crontabWriteFails = 1;
  assert.equal(await confirm(ctx), 1);
  assert.ok(text(ctx).includes(MAY_REMAIN), text(ctx));
  assert.ok(!text(ctx).includes('Nothing buys until a schedule exists'));
});

test('linux: a crontab that cannot be read says an earlier entry may still run, the code could not look', async () => {
  const ctx = ctxFor({ crontab: 'keep\n' });
  ctx.sched.crontabRead = async () => ({ code: 1, stdout: '', stderr: 'crontab: permission denied\n' });
  assert.equal(await confirm(ctx), 1);
  assert.ok(text(ctx).includes(MAY_REMAIN), text(ctx));
  assert.ok(!text(ctx).includes('Nothing buys until a schedule exists'));
});

test('linux: a crontab write that fails with no AvgKeeper line seen still says nothing buys', async () => {
  const ctx = ctxFor({ crontab: '0 1 * * * other.sh\n' });
  ctx.sched.crontabWriteFails = 1;
  assert.equal(await confirm(ctx), 1);
  assert.ok(text(ctx).includes('Nothing buys until a schedule exists.'), text(ctx));
  assert.ok(!text(ctx).includes('may still be installed'));
});

test('macOS: a failed install prints the crontab warning too, and with the crontab unlooked it does not say nothing buys', async () => {
  const ctx = ctxFor({ platform: 'darwin', crontab: 'keep\n' });
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  ctx.sched.bootstrapFails = 5;
  assert.equal(await confirm(ctx), 1);
  const t = text(ctx);
  assert.match(t, /^WARNING: AvgKeeper could not read your crontab \(crontab -l exited 2: crontab: permission denied\), so it could not check it for an old AvgKeeper line\./m);
  assert.ok(t.includes(MAY_REMAIN), t);
  assert.ok(!t.includes('Nothing buys until a schedule exists'));
});

// Item 5 (2026-09-30 review): on macOS, launchd has nothing but the crontab holds an AvgKeeper line for this profile and
// mode. That line fires, so doctor must not call the schedule missing and offer to install another.
test('macOS doctor: no launchd job but a crontab line added by hand is reported installed by hand, never missing', async () => {
  const ctx = ctxFor();
  await confirm(ctx);
  const line = ctx.sched.crontab.split('\n').find((l) => l.includes('avgkeeper.mjs buy'));
  ctx.platform = 'darwin';
  ctx.sched.crontab = `${line}\n`;
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /Schedule: installed \(crontab, the system scheduler; this crontab line was added by hand, not by AVGPLAN\)/);
  assert.doesNotMatch(t, /install one of these yourself|Install one of these yourself|Option 2, launchd/);
});

test('macOS doctor: a different crontab line for the profile and no launchd job is "an entry is installed but differs", not missing', async () => {
  const ctx = ctxFor({ platform: 'darwin', crontab: `${PASTED}\n` });
  await confirm(ctx);
  ctx.sched.files.clear();
  ctx.sched.loaded.clear();
  ctx.sched.crontab = `${PASTED}\n`;
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /Schedule: an entry is installed \(crontab, the system scheduler\) but it differs from this plan/);
});

// Item 6 (2026-09-30 review): SKILL.md says doctor "Exits 1 when it prints a FAIL line". The config.json FAIL line used to
// leave the exit code at 0. Each state below must exit 1 exactly when a FAIL line was printed.
test('doctor exits 1 exactly when it printed a FAIL line, including the config.json one', async () => {
  const states = {
    'no plan, nothing installed': async () => ctxFor(),
    'installed plan': async (ctx) => { await confirm(ctx); return ctx; },
    'stopped plan': async (ctx) => { await confirm(ctx); await stopVerb(ctx, { profile: 't' }); return ctx; },
  };
  for (const [name, build] of Object.entries(states)) {
    for (const broken of [false, true]) {
      const ctx = await build(ctxFor());
      if (broken) fs.writeFileSync(path.join(ctx.store.home, 'config.json'), '{nope');
      ctx.lines.length = 0;
      const code = await doctorVerb(ctx, { profile: 't' });
      const printedFail = ctx.lines.some((l) => l.startsWith('FAIL:'));
      assert.equal(printedFail, broken, `${name}, broken config ${broken}: ${text(ctx)}`);
      assert.equal(code, printedFail ? 1 : 0, `${name}, broken config ${broken}`);
    }
  }
});
