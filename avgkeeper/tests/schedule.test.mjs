// avgkeeper/tests/schedule.test.mjs
import {
  makeCtx, fakeSched, fakeExchange, LOSING, OWNER, text, kinds, tmpDir, T0, DAY, withoutComments,
} from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buySchedule, launchdConfig, doctorVerb, smokeVerb, shWord, ENTRY_SCRIPT, runChild, scheduleRisks, savedPlistDiffWarning, launchdPlistPath,
  launchdRemoveLines, scheduleWakes, viaPhrase,
} from '../scripts/schedule.mjs';
import { OkxError } from '../scripts/runner.mjs';
import { NO_CLI_LINE } from '../scripts/guards.mjs';
import { commandText } from '../scripts/cmdtext.mjs';
import { planVerb } from '../scripts/plan.mjs';
import { stopVerb } from '../scripts/manage.mjs';
import { activePlan } from '../scripts/planview.mjs';
import { createStore, resolveAvgkeeperHome } from '../scripts/store.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function okxDir() {
  const dir = tmpDir('ak-bin-');
  const p = path.join(dir, 'okx');
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, 0o755);
  return dir;
}
const at1005 = { at: '10:05' };
const planFlags = { profile: 't', budget: '10', every: 'day', method: 'equal' };

// Review finding (schedule.mjs:100, should): the printed cron line is the one artifact every scheduled buy runs,
// yet smoke never spawns from the string itself (it spawns from cronEnv and args separately, the comment at
// schedule.mjs:96), so nothing actually runs the line a HOME, AVGKEEPER_HOME, skill folder or log path with a
// space or a percent would break. Real spawn, no crontab, no real okx CLI: this builds the exact line buySchedule
// prints, strips its own five leading time fields (cron's own job, not sh's), un-escapes \% the way cron itself
// does before handing the command to sh, and runs the remainder under env -i /bin/sh -c against the fixture okx
// CLI (fresh-install.test.mjs's own double).
const FAKE_OKX = fileURLToPath(new URL('./fixtures/fake-okx.mjs', import.meta.url));
test('the printed cron line runs correctly under a real shell, even with a space and a percent in the paths', () => {
  const base = tmpDir('ak-cronline-');
  // A space and a percent: the two characters cron and a plain shell both treat specially, and cronWord/shWord
  // exist to survive.
  const home = path.join(base, 'ho me % 1');
  const akHome = path.join(base, 'ak ho%me');
  const bin = path.join(base, 'bi n');
  for (const d of [home, akHome, bin]) fs.mkdirSync(d, { recursive: true });
  const specPath = path.join(base, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify({
    '--version': { stdout: '1.4.6\n' },
    'spot place --help': { stdout: '--tgtCcy --aiBuilderCode\n' },
    'config show': { stdout: { profiles: { t: { site: 'global' } } } },
    'account config': { stdout: [{ perm: 'read_only,trade', ip: '1.2.3.4' }] },
    'account balance': {
      stdout: [{
        details: [
          { ccy: 'USDT', eqUsd: '1000', availBal: '1000', openAvgPx: '', spotUplRatio: '' },
          { ccy: 'ETH', eqUsd: '500', availBal: '0.3', openAvgPx: '2000', spotUplRatio: '-0.10' },
        ],
      }],
    },
    'market instruments': { stdout: [{ instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.0001', lotSz: '0.00000001' }] },
    'market ticker': { stdout: [{ instId: 'ETH-USDT', last: '1767.30' }] },
    'spot place': { stdout: [{ clOrdId: 'x', ordId: '1', sCode: '0', sMsg: '' }] },
    'spot get': [
      { code: 1, stderr: 'Error: Order does not exist\nCode: 51603\n' },
      { stdout: [{ state: 'filled', accFillSz: '0.00566', avgPx: '1767.30' }] },
    ],
  }));
  fs.writeFileSync(
    path.join(bin, 'okx'),
    `#!/bin/sh\nAK_FAKE=${shWord(specPath)} exec ${shWord(process.execPath)} ${shWord(FAKE_OKX)} "$@"\n`,
  );
  fs.chmodSync(path.join(bin, 'okx'), 0o755);
  // A symlinked node in its own space-holding directory, ahead of everything else on PATH, so stableNode
  // (cmdtext.mjs) resolves node itself to a path with a space too: the node half of the cron line's own command
  // (not only its env values) has to survive one, the same as the script and env parts do.
  const nodeDir = path.join(base, 'no de');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
  // AVGKEEPER_OKX_BIN names the fixture by its own absolute path (the same reason fresh-install.test.mjs's own
  // okxEnv() does): a bare PATH search would put node's own directory first, and this dev machine has a real okx
  // CLI installed right next to its own node binary, which must never be reached.
  const env = {
    HOME: home, PATH: `${nodeDir}:${bin}:/usr/bin:/bin`, AVGKEEPER_HOME: akHome, AVGKEEPER_OWNER_TEST: '1', AVGKEEPER_OKX_BIN: path.join(bin, 'okx'),
  };
  // A daily plan whose buy time (00:01) and start date are certainly already past, so it is due the instant this
  // runs, whatever real wall-clock day the suite happens to run on.
  const plan = {
    id: 'pcron1', profile: 't', env: 'live', budget: '10.00', cadence: 'day', at: '00:01', method: 'equal', only: ['ETH'], exclude: null, dust: '10.00', timeZone: 'Europe/Istanbul', anchorDate: '2020-01-01', activeFrom: '2020-01-01 00:01',
  };
  const s = buySchedule(env, { profile: 't' }, plan);
  assert.equal(s.storeHome, resolveAvgkeeperHome(home, akHome));
  const store = createStore(s.storeHome);
  store.appendLedger({ kind: 'plan_active', ...plan }, Date.parse('2020-01-01T00:01:00.000Z'));
  // Cron's own two jobs, done here by hand: the five leading time fields (`M H * * *`) are cron's own schedule,
  // never sh's, and cron un-escapes \% back to a literal % before it ever hands the command to sh.
  const command = s.line.replace(/^(\S+\s+){5}/, '').replace(/\\%/g, '%');
  const r = spawnSync('/usr/bin/env', ['-i', '/bin/sh', '-c', command], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}\ncommand: ${command}`);
  const logged = fs.readFileSync(s.logPath, 'utf8');
  assert.match(logged, /AvgKeeper bought \d{4}-\d{2}-\d{2}: ETH 10\.00 USDT\./, logged);
});

async function planned(env, config) {
  const ctx = makeCtx({ env, okx: fakeExchange(LOSING), config });
  await planVerb(ctx, planFlags);
  await planVerb(ctx, { ...planFlags, confirm: 'AVGPLAN' });
  // Confirm installs into the fake; these tests are about what doctor prints when nothing is installed yet, so the
  // fake starts empty again. The installed case has its own tests (tests/install.test.mjs).
  ctx.sched = fakeSched();
  ctx.lines.length = 0;
  return ctx;
}
// An entry a stop could not take out: doctor must still print the removal commands for it.
function leftoverPlist(ctx) {
  ctx.sched.files.set(launchdPlistPath({ profile: 't', demo: false }, ctx.realHome), '<plist/>');
}

test('the cron line fires at the plan time with the schedule environment', () => {
  const dir = okxDir();
  const s = buySchedule({ PATH: dir, HOME: '/Users/x' }, { profile: 't' }, at1005);
  assert.match(s.line, /^5 10 \* \* \* HOME=\/Users\/x PATH=/);
  assert.match(s.line, /AVGKEEPER_SCHEDULED=1 /);
  assert.match(s.line, /avgkeeper\.mjs buy --profile t /);
  // Item 4 of the 2026-09-27 release audit: the printed line appends the redirect that gives a scheduled run's
  // own output a home, into the same file status and doctor read back (runlog.mjs).
  assert.equal(s.logPath, path.join('/Users/x', '.avgkeeper', 'buy-t-live.log'));
  assert.ok(s.line.endsWith(` >> ${s.logPath} 2>&1`), s.line);
  assert.ok(!s.line.includes('AVGKEEPER_OWNER_TEST'));
  const owner = buySchedule({ PATH: dir, HOME: '/Users/x', ...OWNER }, { profile: 't', demo: true }, at1005);
  assert.match(owner.line, /AVGKEEPER_OWNER_TEST=1 /);
  assert.match(owner.line, /buy --profile t --demo /);
  assert.equal(owner.logPath, path.join('/Users/x', '.avgkeeper', 'buy-t-demo.log'));
  assert.ok(owner.line.endsWith(` >> ${owner.logPath} 2>&1`), owner.line);
});

// Finding 34 remaining: AVGKEEPER_HOME's own value in cronEnv (and so in the printed line) was never checked
// against the raw input, only that the key was present; a mutant that passed the raw, unresolved value survived.
// cron and launchd start in a different working directory, so a relative or `..`-laden value would otherwise name
// one store here and a different one there.
test('AVGKEEPER_HOME reaches cronEnv and the printed line resolved, never raw', () => {
  const dir = okxDir();
  const raw = '/tmp/ak-elsewhere/../ak-actual';
  const resolved = path.resolve(raw);
  const s = buySchedule({ PATH: dir, HOME: '/Users/x', AVGKEEPER_HOME: raw }, { profile: 't' }, at1005);
  assert.deepEqual(s.cronEnv.find(([k]) => k === 'AVGKEEPER_HOME'), ['AVGKEEPER_HOME', resolved]);
  assert.ok(s.line.includes(`AVGKEEPER_HOME=${resolved}`), s.line);
  assert.ok(!s.line.includes(raw), s.line);
});

// When node and okx live in the same folder, that folder must appear once in the cron PATH, not twice.
test('the cron PATH has no duplicate folder when node and okx share one', () => {
  const dir = tmpDir('ak-bin-');
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  const okxPath = path.join(dir, 'okx');
  fs.writeFileSync(okxPath, '#!/bin/sh\n');
  fs.chmodSync(okxPath, 0o755);
  const s = buySchedule({ PATH: dir, HOME: '/Users/x' }, { profile: 't' }, at1005);
  assert.equal(s.node, path.join(dir, 'node'));
  assert.equal(s.okx, okxPath);
  const pathWord = s.cronEnv.find(([k]) => k === 'PATH')[1];
  const segments = pathWord.split(':');
  assert.deepEqual(segments, [...new Set(segments)]);
  assert.ok(segments.includes(dir));
  assert.equal(segments.filter((seg) => seg === dir).length, 1);
});

test('no okx on PATH is named', () => {
  assert.match(buySchedule({ PATH: '/nowhere' }, { profile: 't' }, at1005).why, /no okx on PATH/);
});

// Section 10: an hourly plan's cron fires every hour at the minute, with no hour/day/month/weekday field.
const hourlyAt = { cadence: 'hour', at: ':05' };
test('an hourly plan crons every hour at the minute', () => {
  const dir = okxDir();
  const s = buySchedule({ PATH: dir, HOME: '/Users/x' }, { profile: 't' }, hourlyAt);
  assert.equal(s.hourly, true);
  assert.equal(s.minute, 5);
  assert.equal(s.hour, null);
  assert.match(s.line, /^5 \* \* \* \* HOME=\/Users\/x PATH=/);
  assert.match(s.line, /avgkeeper\.mjs buy --profile t /);
  assert.ok(s.line.endsWith(` >> ${s.logPath} 2>&1`), s.line);
});

test('a daily plan still crons at its hour and minute (unchanged)', () => {
  const dir = okxDir();
  const s = buySchedule({ PATH: dir, HOME: '/Users/x' }, { profile: 't' }, at1005);
  assert.equal(s.hourly, false);
  assert.match(s.line, /^5 10 \* \* \* HOME=/);
});

test('the plist uses the same environment and the plan time', () => {
  const l = launchdConfig({ PATH: okxDir(), HOME: '/Users/x' }, { profile: 't' }, at1005, '/Users/real');
  assert.equal(l.plistPath, '/Users/real/Library/LaunchAgents/com.avgkeeper.buy.t.plist');
  assert.match(l.plist, /<key>Hour<\/key>\n\t\t<integer>10<\/integer>/);
  assert.match(l.plist, /<key>Minute<\/key>\n\t\t<integer>5<\/integer>/);
  assert.match(l.plist, /<key>AVGKEEPER_SCHEDULED<\/key>\n\t\t<string>1<\/string>/);
  assert.match(l.load, /^launchctl bootstrap gui\/\$\(id -u\) /);
});

// Mutation review (2026-09-28), finding schedule.mjs:106, later: SURVIVED r5-plist-no-amp-escape. An & in HOME or
// AVGKEEPER_HOME gives invalid XML that launchctl cannot load; doctor still prints it and smoke --launchd only
// compares the saved text against the printed text, never parses either as XML.
test('the plist escapes an & in an env value, so it stays valid XML', () => {
  const l = launchdConfig({ PATH: okxDir(), HOME: '/Users/x & co' }, { profile: 't' }, at1005, '/Users/real');
  assert.match(l.plist, /<key>HOME<\/key>\n\t\t<string>\/Users\/x &amp; co<\/string>/);
  assert.doesNotMatch(l.plist, /\/Users\/x & co</);
});

// Mutation review (2026-09-28), finding schedule.mjs:106, later: SURVIVED r5-plist-runatload-true. RunAtLoad true
// starts a buy the instant the plist loads, or at every login while it is loaded, whenever a period happens to be
// due right then, instead of only at the scheduled minute.
test('the plist never sets RunAtLoad true', () => {
  const l = launchdConfig({ PATH: okxDir(), HOME: '/Users/x' }, { profile: 't' }, at1005, '/Users/real');
  assert.match(l.plist, /<key>RunAtLoad<\/key>\n\t<false\/>/);
  assert.doesNotMatch(l.plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
});

// Mutation review (2026-09-28), finding schedule.mjs:106, later: SURVIVED r5-cron-path-no-okx-dir. An okx CLI
// installed in a different folder than node (a custom npm prefix, say) is not found by cron or launchd, which
// never see this session's own PATH the way a real spawn from this terminal would.
test('the cron PATH holds both node\'s own folder and okx\'s, even when they differ', () => {
  const dir = okxDir();
  const s = buySchedule({ PATH: dir, HOME: '/Users/x' }, { profile: 't' }, at1005);
  assert.ok(s.cronEnv.find(([k]) => k === 'PATH')[1].split(':').includes(path.dirname(s.okx)), s.cronEnv);
  assert.notEqual(path.dirname(s.node), path.dirname(s.okx), 'this test only proves something when the two folders differ');
});

// Review finding (schedule.mjs:107): no test pinned the .demo suffix in the launchd label and plist name. A demo
// plan and a live plan for the same profile must never share one plist: saving the second would overwrite the
// first, and `stop --demo` would bootout and rm the live schedule.
test('a demo plan gets its own launchd label and plist path, distinct from the live one', () => {
  const live = launchdConfig({ PATH: okxDir(), HOME: '/Users/x' }, { profile: 't' }, at1005, '/Users/real');
  const demo = launchdConfig({ PATH: okxDir(), HOME: '/Users/x' }, { profile: 't', demo: true }, at1005, '/Users/real');
  assert.equal(live.label, 'com.avgkeeper.buy.t');
  assert.equal(demo.label, 'com.avgkeeper.buy.t.demo');
  assert.equal(live.plistPath, '/Users/real/Library/LaunchAgents/com.avgkeeper.buy.t.plist');
  assert.equal(demo.plistPath, '/Users/real/Library/LaunchAgents/com.avgkeeper.buy.t.demo.plist');
  assert.notEqual(live.plistPath, demo.plistPath);
  assert.equal(launchdPlistPath({ profile: 't', demo: true }, '/Users/real'), demo.plistPath);
});

// Finding 33 remaining: the test above only ever calls launchdConfig directly; no test ran doctorVerb itself with
// demo:true and checked the launchd section it prints. A probe mutant that dropped demo at doctor's own call site
// (launchdConfig(env, { profile: o.profile }, plan, ctx.realHome)) survived the full suite: doctor --demo would
// then print the live plist path and ProgramArguments with no --demo, silently pointing the user at the wrong file.
test('doctor --demo prints the demo plist path and --demo in ProgramArguments, never the live plist', async () => {
  const ctx = makeCtx({ env: { ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, okx: fakeExchange(LOSING) });
  await planVerb(ctx, { ...planFlags, demo: true });
  await planVerb(ctx, { ...planFlags, demo: true, confirm: 'AVGPLAN' });
  ctx.sched = fakeSched(); // confirm installed into the fake; this test reads doctor's not-installed output
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't', demo: true });
  const t = text(ctx);
  assert.match(t, /Save this as \/Users\/test\/Library\/LaunchAgents\/com\.avgkeeper\.buy\.t\.demo\.plist:/);
  assert.match(t, /<string>--demo<\/string>/);
  assert.doesNotMatch(t, /com\.avgkeeper\.buy\.t\.plist:/);
});

// Section 10: StartCalendarInterval carries Minute only for an hourly plan, so it fires every hour.
test('an hourly plist sets Minute only, with no Hour key', () => {
  const l = launchdConfig({ PATH: okxDir(), HOME: '/Users/x' }, { profile: 't' }, hourlyAt, '/Users/real');
  assert.match(l.plist, /<key>StartCalendarInterval<\/key>\n\t<dict>\n\t\t<key>Minute<\/key>\n\t\t<integer>5<\/integer>\n\t<\/dict>/);
  assert.ok(!l.plist.includes('<key>Hour</key>'), l.plist);
});

test('doctor without a plan says the schedule comes after a plan', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  assert.match(text(ctx), /PASS: okx CLI/);
  assert.match(text(ctx), /No plan yet/);
});

// Review finding (manage.mjs:199 area, later): the skipped line here is the would-be plan_active itself, so a
// plan may in fact be running; "No plan yet" stated the opposite as fact, same as status and holdings did before
// this fix (rule 4, a fact one surface knows, every surface knows).
test('doctor hedges "No plan yet" while the ledger is torn, instead of stating it as fact', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), '{"kind":"plan_active","id":\n');
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /WARNING: line 1 of .*ledger\.jsonl could not be read and was skipped/, t);
  assert.match(t, /No plan yet: make one with AVGPLAN\. No AvgKeeper schedule entry is installed for profile t \(live\)\. AvgKeeper cannot be sure: a ledger line could not be read \(see the WARNING above\)\./, t);
});

// Finding 13 of the 2026-09-27 release-readiness review: doctor used to PASS a key that cannot trade.
test('doctor fails a key that cannot trade, and its PASS line names both permissions', async () => {
  const bad = makeCtx({ env: OWNER, okx: fakeExchange({ ...LOSING, perm: 'read_only' }) });
  assert.equal(await doctorVerb(bad, { profile: 't' }), 1);
  assert.match(text(bad), /^FAIL: API key t cannot trade\. Turn on Trade for it on the OKX website, with Withdraw still off\.$/m);
  assert.doesNotMatch(text(bad), /PASS: okx CLI/);
  const good = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await doctorVerb(good, { profile: 't' });
  assert.match(text(good), /^PASS: okx CLI, OKX Global profile t, and an API key that can trade and cannot withdraw\.$/m);
});

// Item 3 of the 2026-09-27 release audit: a plan that was stopped still gets the removal lines, not a bare
// "No plan yet" that reads as if no schedule had ever been installed.
test('doctor prints removal lines for the last plan even after it was stopped', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await stopVerb(ctx, { profile: 't' });
  leftoverPlist(ctx);
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  const plistPath = launchdPlistPath({ profile: 't', demo: false }, ctx.realHome);
  assert.ok(!t.includes('No plan yet'), t);
  assert.match(t, /No plan is running now \(it was stopped or replaced\), but an AvgKeeper schedule entry from an earlier plan is still installed\./);
  assert.ok(t.includes(`If you used launchd, run both: launchctl bootout gui/$(id -u)/com.avgkeeper.buy.t, then rm ${shWord(plistPath)}.`), t);
  assert.match(t, /If you used crontab, delete the AvgKeeper lines from your crontab yourself \(crontab -e\): the "# avgkeeper" comment and the line under it\./);
});

// Item 5 of the 2026-09-30 follow-up: once stop has removed the entry, doctor says nothing is installed and prints
// no removal commands; when the read itself fails it says it could not tell and prints them.
test('doctor after stop: nothing installed prints one sentence and no removal commands', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await stopVerb(ctx, { profile: 't' });
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /^No plan is running now \(it was stopped or replaced\)\. No AvgKeeper schedule entry is installed for profile t \(live\)\.$/m, t);
  assert.doesNotMatch(t, /launchctl bootout|If you used crontab|rm /, t);
});

test('doctor after stop: a crontab it cannot read is named unknown and the removal commands are printed', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await stopVerb(ctx, { profile: 't' });
  ctx.sched.crontabRead = async () => ({ code: 2, stdout: '', stderr: 'crontab: permission denied\n' });
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.match(t, /AvgKeeper could not tell whether a schedule entry is installed \(crontab -l exited 2: crontab: permission denied\)\. If one is, take it out so it stops firing for nothing:/, t);
  assert.match(t, /If you used crontab, delete the AvgKeeper lines/, t);
  assert.doesNotMatch(t, /No AvgKeeper schedule entry is installed/, t);
});

test('doctor never printed a removal line before any plan ever existed', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await doctorVerb(ctx, { profile: 't' });
  assert.ok(!text(ctx).includes('launchctl'), text(ctx));
});

test('doctor with a plan prints the cron line and the plist', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /0 10 \* \* \* HOME=/);
  assert.match(t, /com\.avgkeeper\.buy\.t\.plist/);
  assert.match(t, /avgkeeper\.mjs buy --smoke --profile t$/m);
  assert.match(t, /avgkeeper\.mjs buy --smoke --launchd --profile t$/m);
  // Item 4 of the 2026-09-27 release audit: named once, plainly, so the redirect at the end of the cron line and
  // the plist's own StandardOutPath are not the only place a user could learn where a run's output goes. Later
  // item L2 of the release-readiness review: the old "never shown anywhere else" was false, since notify, mail,
  // status and doctor all show parts of it.
  assert.match(t, /^Either way, each run's full output is also appended to .*buy-t-live\.log; status and doctor show its last lines when the last one does not read like an ordinary finish\.$/m);
  assert.ok(!t.includes('never shown anywhere else'), t);
});

// Item 9 of the 2026-09-27 release audit: doctor's own read-only compare of a plist already saved on disk against
// the one it prints now, separate from smoke --launchd (which fails outright when nothing is saved yet).
test('doctor warns when a saved plist no longer matches the one it prints now', async () => {
  const env = { ...OWNER, PATH: okxDir(), HOME: '/Users/x' };
  const ctx = await planned(env);
  ctx.realHome = tmpDir('ak-home-');
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  const l = launchdConfig(env, { profile: 't' }, plan, ctx.realHome);
  await doctorVerb(ctx, { profile: 't' });
  assert.ok(!text(ctx).includes('differs from the one printed above'), 'nothing saved yet is not a warning');
  fs.mkdirSync(path.dirname(l.plistPath), { recursive: true });
  fs.writeFileSync(l.plistPath, l.plist.replace('<integer>10</integer>', '<integer>11</integer>'));
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  assert.match(text(ctx), new RegExp(`WARNING: the plist already saved at ${l.plistPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} differs from the one printed above; save the new one and load it again\\.`));
});

test('savedPlistDiffWarning is null with nothing saved yet, and once the saved copy matches', () => {
  const home = tmpDir('ak-home-');
  const plistPath = path.join(home, 'x.plist');
  assert.equal(savedPlistDiffWarning(plistPath, 'a'), null);
  fs.writeFileSync(plistPath, 'a\n');
  assert.equal(savedPlistDiffWarning(plistPath, 'a'), null);
});

// Item 9: a node or okx path with a version number in it (nvm, or Homebrew's Cellar) breaks silently on the next
// upgrade; a skill folder under Desktop, Documents or Downloads can be blocked from reading by macOS privacy
// protection that a smoke run from this terminal cannot show.
test('scheduleRisks warns about a version-numbered node or okx path', () => {
  const cron = { node: '/Users/x/.nvm/versions/node/v18.19.0/bin/node', okx: '/usr/local/Cellar/okx-cli/1.4.6/bin/okx' };
  const risks = scheduleRisks(cron, { platform: 'darwin', realHome: '/Users/x' });
  assert.equal(risks.length, 2);
  assert.match(risks[0], /has a version number in it/);
  assert.match(risks[1], /has a version number in it/);
  assert.deepEqual(scheduleRisks({ node: '/usr/local/bin/node', okx: '/usr/local/bin/okx' }, { platform: 'darwin', realHome: '/Users/x' }), []);
});

test('scheduleRisks warns when the skill script or its store sits under Desktop, Documents or Downloads, on macOS only', () => {
  const cron = { script: '/Users/x/Desktop/avgkeeper/scripts/avgkeeper.mjs', storeHome: '/Users/x/Documents/.avgkeeper' };
  const risks = scheduleRisks(cron, { platform: 'darwin', realHome: '/Users/x' });
  assert.equal(risks.length, 2);
  assert.match(risks[0], /~\/Desktop\/avgkeeper\/scripts\/avgkeeper\.mjs is under ~\/Desktop/);
  assert.match(risks[1], /~\/Documents\/\.avgkeeper is under ~\/Documents/);
  assert.deepEqual(scheduleRisks(cron, { platform: 'linux', realHome: '/Users/x' }), [], 'the privacy risk is macOS only');
});

// Item 6 of the 2026-09-27 release audit: doctor warns the same way the plan card does when the key has no IP
// bound and the plan's own cadence can leave OKX untouched past OKX's own 14-day key inactivity window.
test('doctor warns when the key has no IP bound and the cadence can leave a gap past 14 days', async () => {
  const env = { ...OWNER, PATH: okxDir(), HOME: '/Users/x' };
  const ctx = makeCtx({ env, okx: fakeExchange({ ...LOSING, ip: '' }) });
  const gapFlags = {
    profile: 't', budget: '10', every: 'days:20', method: 'equal',
  };
  await planVerb(ctx, gapFlags);
  await planVerb(ctx, { ...gapFlags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /WARNING: this API key has no IP address bound to it\..*okx\.com\/en-us\/help\/api-faq/s);
});

test('doctor does not warn when the ip field was never read: unknown is not evidence of no IP bound', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await doctorVerb(ctx, { profile: 't' });
  assert.doesNotMatch(text(ctx), /WARNING: this API key has no IP/);
});

// Item 3 of the 2026-09-27 release audit: bootout alone leaves the plist file, which launchd loads again at the
// next login, so an active plan would quietly resume. doctor must print rm too, and say stop is what ends buying.
test('doctor prints bootout then rm for the launchd plist, and says stop ends the plan', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  const l = launchdConfig({ PATH: okxDir(), HOME: '/Users/x', ...OWNER }, { profile: 't' }, plan, ctx.realHome);
  await doctorVerb(ctx, { profile: 't' });
  const lines = ctx.lines;
  const bootoutIdx = lines.indexOf(l.remove[0]);
  const rmIdx = lines.indexOf(`rm ${shWord(l.plistPath)}`);
  assert.ok(bootoutIdx > -1, text(ctx));
  assert.ok(rmIdx > -1, text(ctx));
  assert.ok(bootoutIdx < rmIdx, 'bootout must be printed before rm');
  assert.ok(text(ctx).includes('That only stops the schedule from firing. Ask your agent for stop to end the plan itself.'));
});

// The printed "prove it" line must be a command that actually runs: no bare `avgkeeper` on PATH exists, so it
// has to be node plus the entry script, both through shWord, with a --launchd line on macOS only.
test('the prove-it line is a runnable node command, with a second --launchd line on macOS', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.platform = 'darwin';
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.ok(!t.includes('avgkeeper buy --smoke'), 'must not print the non-existent avgkeeper command');
  assert.match(t, new RegExp(`Then prove it: ${shWord(process.execPath)} ${shWord(ENTRY_SCRIPT)} buy --smoke --profile t$`, 'm'));
  assert.match(t, new RegExp(`With launchd: ${shWord(process.execPath)} ${shWord(ENTRY_SCRIPT)} buy --smoke --launchd --profile t$`, 'm'));
});

test('the prove-it line has no second --launchd line off macOS', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.platform = 'linux';
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /Then prove it: /);
  assert.ok(!t.includes('With launchd:'));
});

// ADDITION (project rule 3, one fact one reader): a torn ledger line is named on doctor too, using the exact
// sentence status shows, from the one shared reader in planview.mjs.
test('doctor also warns about a torn ledger line', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), 'not json\n');
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.ok(t.includes(`could not be read and was skipped. Every scheduled buy refuses until that line is fixed or removed; a second bad line stops every AvgKeeper command.`) && t.includes(ctx.store.home), t);
});

// Item 5 of the 2026-09-26 review: doctor prints the same HALTED and Waiting sentences status prints, from the
// one shared reader in planview.mjs.
test('doctor prints the same HALTED line status prints', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'something unknown.' }, ctx.now());
  await doctorVerb(ctx, { profile: 't' });
  assert.ok(ctx.lines.includes('HALTED: something unknown. Nothing is bought until you make a new plan.'));
});

test('doctor prints the same Waiting line status prints', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: plan.id, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'akone', amount: '5.00', lossPct: 5, profile: 't', env: 'live',
  }, ctx.now());
  await doctorVerb(ctx, { profile: 't' });
  assert.ok(ctx.lines.includes('Waiting: 1 order whose result is not recorded yet; the next scheduled run reads it back.'));
});

// Finding 16 remaining: same fact as status's own test (manage.test.mjs) - a halted plan never reads its own open
// sends back again, so doctor must name stop too, never a read-back that will not happen.
test('doctor\'s Waiting line names stop for a halted plan, never a read-back that will not happen', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: plan.id, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'akone', amount: '5.00', lossPct: 5, profile: 't', env: 'live',
  }, ctx.now());
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'something unknown.' }, ctx.now());
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.doesNotMatch(t, /the next scheduled run reads it back/);
  assert.match(t, /Waiting: 1 order whose result is not recorded yet\. The plan is halted and never reads it back on its own\. Run stop to clear it, then make a new plan\./);
});

// Review finding (schedule.mjs:284, later): doctor for a halted plan still printed the full install block and
// "Then prove it: ... buy --smoke", a command smoke itself is certain to refuse ("FAIL: the plan is halted"). One
// screen invited a command another screen refuses outright.
test('doctor for a halted plan prints no install or prove-it block, only the removal lines', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'something unknown.' }, ctx.now());
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.doesNotMatch(t, /Schedule: AvgKeeper wakes/);
  assert.doesNotMatch(t, /Then prove it:/);
  assert.doesNotMatch(t, /Option 1, crontab/);
  // Review finding (schedule.mjs:292, later): haltedLine (printed just above) already ends "Nothing is bought
  // until you make a new plan."; this block repeated that exact clause word for word on the next line.
  assert.equal((t.match(/Nothing is bought until you make a new plan/g) || []).length, 1, t);
  assert.match(t, /^Make a new plan with AVGPLAN; it replaces this schedule entry\.$/m);
  assert.doesNotMatch(t, /run doctor again/);
  assert.match(t, /If a schedule line from before is still installed, it now buys nothing\. To take it out:/);
  assert.match(t, /crontab -e/);
});

// Item 1 of the 2026-09-27 release audit: doctor prints the same Last run line and dead-schedule WARNING status
// does, from period.mjs's own shared readers, so "PASS" and "Running" never hide a schedule that stopped firing.
test('doctor prints Last run and warns when due periods have no record, matching status', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.setNow(T0 + 4 * DAY + 16 * 60000); // past the grace window (finding L4), not merely at the trigger minute
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /Last run: never; the plan started 2026-10-05 10:00 \(Europe\/Istanbul\)\./);
  assert.match(t, /WARNING: 5 due periods have no record since it started\. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time \(crontab skips those\), or the schedule entry may be gone\. Ask your agent for doctor: it reads whether AvgKeeper's schedule entry is installed and matches this plan\./);
});

// Finding 12 remaining: a stale buy lock held by a live pid refuses every scheduled run before it ever writes a
// period line. doctor already prints its own stale-lock WARNING above this one (manage.test.mjs has the matching
// status test); the missing-periods line must name the same lock, not guess at the schedule.
test('doctor names the stale lock in its missing-periods warning, not a guess at the schedule', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const lockFile = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, start: 1 }));
  const past = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(lockFile, past, past);
  ctx.setNow(T0 + 4 * DAY + 16 * 60000);
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /The buy lock from .* is still held/);
  assert.match(t, /WARNING: 5 due periods have no record since it started: the buy lock has been held without being freed \(see the line above about the buy lock\), which refuses every buy while it is held\./);
  assert.doesNotMatch(t, /AvgKeeper cannot tell why/);
});

// Review finding (period.mjs:315): a dead-pid stale lock refuses nothing (lock(name, {takeover:false}) takes it
// over at any age), so doctor must not blame missing periods on it, matching the same fix on status.
test('doctor never blames a dead-pid stale lock for missing periods', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const lockFile = path.join(ctx.store.home, 'buy-t-live.lock');
  const deadPid = 2 ** 30;
  fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, start: 1 }));
  const past = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(lockFile, past, past);
  ctx.setNow(T0 + 4 * DAY + 16 * 60000);
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.doesNotMatch(t, /still held/);
  assert.match(t, /WARNING: 5 due periods have no record since it started\. AvgKeeper cannot tell why: the computer may have been asleep or off at the buy time \(crontab skips those\), or the schedule entry may be gone\. Ask your agent for doctor: it reads whether AvgKeeper's schedule entry is installed and matches this plan\./);
});

// Spec section 9, "Surfaces": doctor prints the mail line and the pending count, from the same shared reader
// status uses (manage.test.mjs has the matching status test).
test('doctor prints the mail line and the pending notice count from the shared reader', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail: { to: 'a@b.co', level: 'problems' } });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  ctx.store.appendLedger({
    kind: 'notice', id: `${plan.id}:2026-10-05:skip`, profile: 't', env: 'live', to: 'a@b.co', severity: 'problem', subject: 's', body: 'b',
  }, ctx.now());
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /^Mail: problems only, to a@b\.co\.$/m);
  assert.ok(t.includes(`Mail waiting to be sent: 1. See them: ${commandText('mail --pending --profile t')}.`), t);
});

// Review finding (schedule.mjs:274): doctor's own text promises "status and doctor show its last lines", but only
// status's own copy of the log-tail warning was tested (manage.test.mjs's matching test).
test('doctor shows the scheduled log\'s tail once it ends with what looks like a crash', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await doctorVerb(ctx, { profile: 't' });
  assert.ok(!text(ctx).includes('scheduled run'), 'an ordinary run leaves nothing to warn about yet');
  fs.mkdirSync(ctx.store.home, { recursive: true });
  fs.writeFileSync(path.join(ctx.store.home, 'buy-t-live.log'), 'AvgKeeper bought 2026-10-05: ETH 5.00 USDT.\nTypeError: x is not a function\n');
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  // Review finding (schedule.mjs:75 area, later): "last written" now reads in the plan's own local time, with its
  // zone named, the same way "Last run" on this same screen already does, not a bare UTC ISO stamp.
  assert.match(t, /WARNING: the scheduled run's own log \(.*buy-t-live\.log\) ends with a line that does not read like an ordinary finish, last written \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Europe\/Istanbul\)\./);
  assert.doesNotMatch(t, /last written \d{4}-\d{2}-\d{2}T/);
  assert.ok(t.includes('TypeError: x is not a function'), t);
});

// Review findings (schedule.mjs:244): with no notify command, "nothing reaches you" is false whenever mail is on;
// a notify command at level off is off, the same word mailLine uses for the same state.
test('doctor\'s Notify line names mail too when there is no notify command, and calls level off simply off', async () => {
  const noMail = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await doctorVerb(noMail, { profile: 't' });
  assert.match(text(noMail), /^Notify: no command set, so nothing reaches you when a buy is skipped or halted\.$/m);

  const withMail = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail: { to: 'a@b.co', level: 'problems' } });
  await doctorVerb(withMail, { profile: 't' });
  assert.match(text(withMail), /^Notify: no command set\. A skipped \(except for no coin in loss\) or halted buy is prepared as a mail notice \(Mail: problems only, to a@b\.co\) that waits until you ask your agent to send it: no mail command is set\. It also shows in status\.$/m);

  const levelOff = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { notify: 'cat', notifyLevel: 'off' });
  await doctorVerb(levelOff, { profile: 't' });
  assert.match(text(levelOff), /^Notify: off \(a command is set, level off\)\.$/m);
  assert.doesNotMatch(text(levelOff), /^Notify: on, level off\.$/m);
});

test('doctor says Mail: off. when nothing is configured', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await doctorVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /^Mail: off\.$/m);
});

// Section 10: doctor's own wording for an hourly plan, and the cron line it prints alongside it.
test('doctor says every hour at :MM machine time for an hourly plan, and prints the hourly cron line', async () => {
  const env = { ...OWNER, PATH: okxDir(), HOME: '/Users/x' };
  const ctx = makeCtx({ env, okx: fakeExchange(LOSING) });
  const hourlyFlags = { profile: 't', budget: '10', every: 'hour', method: 'equal' };
  await planVerb(ctx, hourlyFlags);
  await planVerb(ctx, { ...hourlyFlags, confirm: 'AVGPLAN' });
  ctx.sched = fakeSched(); // confirm installed into the fake; this test reads doctor's not-installed output
  ctx.lines.length = 0;
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /^Schedule: AvgKeeper wakes every hour at :05 machine time\. Install one of these yourself\.$/m);
  assert.match(t, /^5 \* \* \* \* HOME=/m);
});

// Seen on the owner's demo, 2026-09-28: the hourly plan halted, he ran stop, then confirmed a new plan with the
// same settings. A plan id is a hash of the plan's own settings alone (plan.mjs's planId), so the new plan got the
// halted one's own id back (p10f789c6dd2d). doctor then printed "Last run: a buy was sent, for 2026-09-28 09, on
// 2026-09-28 09:05": a run of the earlier, stopped life of that id, before the new plan ever started. Scoped to
// this plan's own life (its own plan_active line's ts) so a same-id restart's doctor always starts clean.
test('doctor never credits an earlier incarnation\'s own buy as this plan\'s Last run, after a same-id restart', async () => {
  const env = { ...OWNER, PATH: okxDir(), HOME: '/Users/x' };
  const ctx = makeCtx({ env, okx: fakeExchange(LOSING), now: Date.UTC(2026, 8, 28, 5, 0) }); // 08:00 Istanbul
  const hourlyFlags = { profile: 't', budget: '10', every: 'hour', method: 'equal' };
  await planVerb(ctx, hourlyFlags);
  await planVerb(ctx, { ...hourlyFlags, confirm: 'AVGPLAN' });
  const firstId = activePlan(ctx.store.readLedger(), { profile: 't', demo: false }).id;
  // The old life's own run at 09:05: a buy sent, then halted before period_done was ever written, the shape a real
  // halt mid-buy leaves (and the one the owner's own demo doctor line named).
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: firstId, period: '2026-09-28 09', instId: 'ETH-USDT', clOrdId: 'a', amount: '10', profile: 't', env: 'live',
  }, Date.UTC(2026, 8, 28, 6, 5));
  ctx.store.appendLedger({ kind: 'plan_halted', planId: firstId, profile: 't', env: 'live', reason: 'the read-back timed out' }, Date.UTC(2026, 8, 28, 6, 6));
  await stopVerb(ctx, { profile: 't' });
  ctx.setNow(Date.UTC(2026, 8, 28, 8, 2)); // 11:02 Istanbul, confirmed again with identical settings
  await planVerb(ctx, hourlyFlags);
  await planVerb(ctx, { ...hourlyFlags, confirm: 'AVGPLAN' });
  const secondId = activePlan(ctx.store.readLedger(), { profile: 't', demo: false }).id;
  assert.equal(secondId, firstId, 'identical settings hash to the same plan id');
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.doesNotMatch(t, /Last run: a buy was sent, for 2026-09-28 09/, t);
  assert.match(t, /^Last run: never; the plan started 2026-09-28 11:02 \(Europe\/Istanbul\)\.$/m);
});

// Daily and longer cadences must read byte for byte as before (section 10, "Unchanged").
test('doctor says a plain daily plan wakes every day and buys each time, with no buy-days clause', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await doctorVerb(ctx, { profile: 't' });
  assert.match(text(ctx), /^Schedule: AvgKeeper wakes every day at 10:00 machine time\. Install one of these yourself\.$/m);
});

// A weekly plan's entry still wakes every day; the clause says it buys only on the plan's buy days. One reader
// (scheduleWakes) feeds the receipt and doctor, so this pins the wording for every cadence in one place.
test('scheduleWakes: daily and hourly wake on every run, week, month and days:N buy only on buy days', () => {
  assert.equal(scheduleWakes({ cadence: 'day', at: '10:00' }), 'AvgKeeper wakes every day at 10:00 machine time');
  assert.equal(scheduleWakes({ cadence: 'hour', at: ':05' }), 'AvgKeeper wakes every hour at :05 machine time');
  for (const cadence of ['week:mon', 'month:5', 'days:3']) {
    assert.equal(scheduleWakes({ cadence, at: '10:00' }), "AvgKeeper wakes every day at 10:00 machine time and buys only on the plan's buy days", cadence);
  }
  assert.equal(viaPhrase('launchd'), "launchd, macOS's own scheduler");
  assert.equal(viaPhrase('crontab'), 'crontab, the system scheduler');
});

// The exact planLine (cards.mjs) `planned()`'s own plan prints: 10.00 USDT, every day, default 10:00, method
// equal, Europe/Istanbul (helpers.mjs's TZ). Finding 34 remaining: smoke now requires the child's own stdout to
// show this plan, not only DRY_SUMMARY (which buy --dry-run's no-plan branch also prints), so this stub has to
// read like the real dry run of THIS plan, not just any successful one.
const DRY_OK = { code: 0, stdout: '10.00 USDT every day at 10:00 (Europe/Istanbul), split equally.\nbuy: dry run, nothing sent.\n', stderr: '' };
const ledgerText = (ctx) => {
  const f = path.join(ctx.store.home, 'ledger.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

// Item 5 of the 2026-09-26 review: smoke says what it proved (the printed line runs) and writes nothing.
test('smoke passes on exit 0 with the dry-run summary, says it does not check the install, and writes nothing', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { notify: 'cat' });
  const before = ledgerText(ctx);
  const seen = [];
  ctx.runChild = async (file, args) => { seen.push(args); return DRY_OK; };
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 0);
  assert.equal(ledgerText(ctx), before);
  assert.ok(!kinds(ctx).includes('buy_smoke'));
  assert.match(text(ctx), /PASS: the cron schedule line runs: the buy ran as a dry run under cron's environment\. This does not check that the line is installed\./);
  assert.ok(seen[0].includes('AVGKEEPER_SCHEDULED=1'));
  assert.ok(seen[0].includes('--dry-run'));
  assert.equal(seen.length, 2);
});

// Review finding (schedule.mjs:432): smoke's own PASS criterion was pinned only by feeding it DRY_OK or a
// non-zero exit; a child that exits 0 with no useful output (the exact failure the realpath fix, entry.mjs, was
// about) was never tried, and a mutant checking only the exit code survived.
test('smoke fails on exit 0 whose stdout does not read like a real dry run', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.runChild = async () => ({ code: 0, stdout: '', stderr: '' });
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /FAIL: the buy exited 0 under cron's environment/);
});

// Finding 34 remaining: smoke required only DRY_SUMMARY in the child's stdout, and buy --dry-run's own no-plan
// branch prints that same line (buy.mjs, DRY_SUMMARY). A schedule environment pointing at a different store, or
// one with no plan at all, would still pass smoke and never buy. The child's own planLine (proof it read THIS
// plan) is now required too.
//
// Review finding (schedule.mjs:449, should): this used to fall into the generic "FAIL: the buy exited 0..."
// sentence, worded as if a non-zero exit or a garbled dry run were the problem. The real, checked cause here is
// narrower: the child's own dry run ran fine, under a store that is not this plan's own, so it gets its own line.
test('smoke fails when the child\'s stdout never shows the running plan (a different or missing store)', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.runChild = async () => ({
    code: 0,
    stdout: "No plan is running yet; OKX answered this run. buy --smoke tests the schedule's own environment once a plan exists.\nbuy: dry run, nothing sent.\n",
    stderr: '',
  });
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  const t = text(ctx);
  assert.doesNotMatch(t, /FAIL: the buy exited 0 under cron's environment/);
  assert.match(t, /FAIL: the dry run under cron's environment did not see this plan; it read a different AvgKeeper store, or none, at .*\.avgkeeper \(it said: No plan is running yet; OKX answered this run\. buy --smoke tests the schedule's own environment once a plan exists\.\)\./);
});

// Review findings (schedule.mjs:457, should, both money and paths lenses): the child dry run already checks its
// own resolved time zone against the plan's (buy.mjs's timeZoneWarning) and prints the WARNING when they differ,
// but smokeVerb only ever checked DRY_SUMMARY and planLine, both of which the dry run still prints even with the
// WARNING right above them. cron and launchd never see TZ, so a plan made from a shell with TZ exported is the
// realistic trigger: every scheduled run then fires hours away from the plan's own buy time, or never at all.
test('smoke fails when the child dry run carries the time zone WARNING', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  const warning = `WARNING: this plan was made in ${plan.timeZone}, but this Mac is now on Europe/London. The schedule fires at machine time, so make a new plan with AVGPLAN, which reinstalls the schedule.`;
  ctx.runChild = async () => ({ code: 0, stdout: `${warning}\n${DRY_OK.stdout}`, stderr: '' });
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  const t = text(ctx);
  assert.doesNotMatch(t, /^PASS/m);
  assert.match(t, new RegExp(`FAIL:.*${warning.replace(/[.()]/g, '\\$&')}`));
});

// Review finding (schedule.mjs:432): AVGKEEPER_HOME must actually reach the schedule environment smoke tests, or
// a schedule environment that cannot see the running plan (a different store) would still pass. No test asserted
// this: the plist-vs-cron-env test only checks pairs.length >= 4, which still holds without it. Finding 34
// remaining: the value itself, and its path.resolve, were never checked either, only that the key was present.
test('AVGKEEPER_HOME reaches the schedule environment when it is set, resolved not raw', async () => {
  const raw = '/tmp/ak-elsewhere/../ak-actual';
  const resolved = path.resolve(raw);
  const env = { ...OWNER, PATH: okxDir(), HOME: '/Users/x', AVGKEEPER_HOME: raw };
  const ctx = await planned(env);
  ctx.env = env;
  const seen = [];
  ctx.runChild = async (file, args) => { seen.push(args); return DRY_OK; };
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 0);
  assert.ok(seen[0].includes(`AVGKEEPER_HOME=${resolved}`), seen[0].join(' '));
  assert.ok(!seen[0].some((a) => a.includes(raw)), seen[0].join(' '));
});

test('smoke fails on a halted plan and runs nothing', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  ctx.store.appendLedger({ kind: 'plan_halted', planId: plan.id, profile: 't', env: 'live', reason: 'something unknown.' }, ctx.now());
  let ran = 0;
  ctx.runChild = async () => { ran += 1; return DRY_OK; };
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /FAIL: the plan is halted: something unknown\./);
  assert.equal(ran, 0);
});

test('a failing notify command during smoke returns 1 and writes nothing', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { notify: 'false' });
  const before = ledgerText(ctx);
  let n = 0;
  ctx.runChild = async () => { n += 1; return n === 1 ? DRY_OK : { code: 1, stdout: '', stderr: '' }; };
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /WARNING: your notify command exited 1 under cron's environment/);
  assert.equal(ledgerText(ctx), before);
});

// Spec section 9, "Surfaces": buy --smoke sends a test notice through mail.command under the schedule
// environment when one is set, the same way it already proves the notify command, and writes nothing either way.
test('smoke sends a test notice through the mail command under the schedule environment and passes', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail: { to: 'a@b.co', level: 'all', command: 'cat' } });
  const before = ledgerText(ctx);
  const seen = [];
  ctx.runChild = async (file, args) => { seen.push(args); return DRY_OK; };
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 0);
  assert.equal(ledgerText(ctx), before);
  assert.match(text(ctx), /PASS: a test mail notice reached your mail command:/);
  assert.equal(seen.length, 2);
  assert.ok(seen[1].some((a) => a.startsWith('AVGKEEPER_SUBJECT=')), seen[1].join(' '));
  assert.ok(seen[1].includes('AVGKEEPER_NOTIFY_EMAIL=a@b.co'), seen[1].join(' '));
});

// Review finding (schedule.mjs:453): a working mail command proves nothing about whether a real notice would ever
// be prepared. Mail is off (level off, or no usable address) whenever mailLine says so, and smoke must say that
// too, right after the PASS line, not let the command test alone stand as proof mail works.
for (const [why, mail] of [
  ['level off', { to: 'a@b.co', level: 'off', command: 'cat' }],
  ['no address', { level: 'all', command: 'cat' }],
]) {
  test(`smoke's mail command PASS is followed by Mail: off when ${why} leaves mail off`, async () => {
    const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail });
    ctx.runChild = async () => DRY_OK;
    assert.equal(await smokeVerb(ctx, { profile: 't' }), 0);
    const t = text(ctx);
    assert.match(t, /PASS: a test mail notice reached your mail command:/);
    assert.match(t, /Mail: off\. The command works, but no notice is prepared until an address and a level are set\./);
  });
}

test('a failing mail command during smoke returns 1 and writes nothing', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail: { to: 'a@b.co', level: 'all', command: 'false' } });
  const before = ledgerText(ctx);
  let n = 0;
  ctx.runChild = async () => { n += 1; return n === 1 ? DRY_OK : { code: 1, stdout: '', stderr: '' }; };
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /WARNING: your mail command exited 1 under cron's environment/);
  assert.equal(ledgerText(ctx), before);
});

test('smoke with no mail command set says lane 1 is not proven, and writes nothing', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail: { to: 'a@b.co', level: 'all' } });
  const before = ledgerText(ctx);
  ctx.runChild = async () => DRY_OK;
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 0);
  assert.equal(ledgerText(ctx), before);
  assert.ok(ctx.lines.includes(`No mail command is set, so each mail notice waits in ${commandText('mail --pending --profile t')} until you ask your agent to send it.`), text(ctx));
});

// Review finding (schedule.mjs:244): with no notify command, "will show only in status" is false whenever mail
// is on. New regression (schedule.mjs:449): "(see the Mail line)" points at a line this screen never prints, and
// with no mail.command it promised delivery smoke's own later sentence ("waits in mail --pending") contradicts.
test('smoke with no notify command describes what mail actually does, never a dangling pointer', async () => {
  const noMail = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  noMail.runChild = async () => DRY_OK;
  await smokeVerb(noMail, { profile: 't' });
  assert.match(text(noMail), /No notify command is set, so a skipped or halted buy will show only in status\./);

  // Mail on, no mail.command: it does not reach the user on its own, it only waits for the agent.
  const noCommand = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail: { to: 'a@b.co', level: 'problems' } });
  noCommand.runChild = async () => DRY_OK;
  await smokeVerb(noCommand, { profile: 't' });
  const t1 = text(noCommand);
  assert.doesNotMatch(t1, /see the Mail line/);
  assert.match(t1, /No notify command is set\. A skipped \(except for no coin in loss\) or halted buy is prepared as a mail notice \(Mail: problems only, to a@b\.co\) that waits until you ask your agent to send it: no mail command is set\. It also shows in status\./);
  assert.match(t1, /No mail command is set, so each mail notice waits in/, 'the later sentence must agree, not contradict, with the one above it');

  // Mail on, with a command: it does reach the user on its own.
  const withCommand = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { mail: { to: 'a@b.co', level: 'all', command: 'cat' } });
  withCommand.runChild = async () => DRY_OK;
  await smokeVerb(withCommand, { profile: 't' });
  const t2 = text(withCommand);
  assert.doesNotMatch(t2, /see the Mail line/);
  assert.match(t2, /No notify command is set\. A skipped or halted buy also reaches you by mail \(Mail: every buy with its details, to a@b\.co\)\. It also shows in status\./);
});

// A user who never turned mail on is not told that notices wait somewhere: at level off none is ever prepared.
test('smoke with mail off prints the mail line, not a promise that notices wait in --pending', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.runChild = async () => DRY_OK;
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 0);
  assert.doesNotMatch(text(ctx), /mail --pending/);
  assert.equal(ctx.lines.at(-1), 'Mail: off.');
});

// The notify and mail smokes run the user's own shell command: a wrapper's children die with it on a timeout.
test('smoke runs the notify and mail commands detached, so a timeout kills their whole process group', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' }, { notify: 'cat', mail: { to: 'a@b.co', level: 'all', command: 'cat' } });
  const opts = [];
  ctx.runChild = async (file, args, o = {}) => { opts.push(o); return DRY_OK; };
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 0);
  assert.equal(opts.length, 3);
  assert.ok(!opts[0].detached, 'the dry-run buy itself stays in the terminal process group, so Ctrl-C still stops it');
  assert.equal(opts[1].detached, true);
  assert.equal(opts[2].detached, true);
});

test('runChild with detached kills the whole process group on timeout, so a grandchild cannot finish later', async () => {
  const dir = tmpDir('ak-child-');
  const late = path.join(dir, 'late');
  const r = await runChild('/bin/sh', ['-c', `(sleep 1; touch '${late}') & wait`], { timeoutMs: 300, detached: true });
  assert.equal(r.timedOut, true);
  await new Promise((resolve) => { setTimeout(resolve, 1500); });
  assert.equal(fs.existsSync(late), false, 'the orphaned subshell outlived the timeout and ran');
});

test('a smoke run that times out fails and prints the command to rerun it', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.runChild = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /FAIL: the buy did not finish within 300 seconds under cron's environment\./);
  assert.match(text(ctx), /To run the same test yourself: \/usr\/bin\/env -i /);
});

// Item 5c: --launchd reads the saved plist (read only) and fails when it is missing or differs.
test('smoke --launchd fails when the plist is not saved, fails when it differs, and runs the plist form when it matches', async () => {
  const env = { ...OWNER, PATH: okxDir(), HOME: '/Users/x' };
  const ctx = await planned(env);
  ctx.realHome = tmpDir('ak-home-');
  const plan = activePlan(ctx.store.readLedger(), { profile: 't', demo: false });
  const l = launchdConfig(env, { profile: 't' }, plan, ctx.realHome);
  const seen = [];
  ctx.runChild = async (file, args) => { seen.push([file, args]); return DRY_OK; };
  assert.equal(await smokeVerb(ctx, { profile: 't', launchd: true }), 1);
  assert.ok(text(ctx).includes(`FAIL: the launchd plist is not saved yet at ${l.plistPath}. Make the plan again with AVGPLAN, which saves and loads it.`), text(ctx));
  fs.mkdirSync(path.dirname(l.plistPath), { recursive: true });
  fs.writeFileSync(l.plistPath, l.plist.replace('<integer>10</integer>', '<integer>11</integer>'));
  assert.equal(await smokeVerb(ctx, { profile: 't', launchd: true }), 1);
  assert.match(text(ctx), /FAIL: the saved plist differs from the one this plan needs; make the plan again with AVGPLAN, which replaces it\./);
  assert.equal(seen.length, 0);
  fs.writeFileSync(l.plistPath, `${l.plist}\n`);
  const saved = fs.readFileSync(l.plistPath, 'utf8');
  assert.equal(await smokeVerb(ctx, { profile: 't', launchd: true }), 0);
  assert.equal(fs.readFileSync(l.plistPath, 'utf8'), saved);
  assert.equal(seen.length, 1);
  const [file, args] = seen[0];
  assert.equal(file, '/usr/bin/env');
  assert.deepEqual(args, ['-i', ...l.cronEnv.map(([k, v]) => `${k}=${v}`), l.node, l.script, 'buy', '--dry-run', '--profile', 't']);
  assert.match(text(ctx), /PASS: the launchd schedule line runs/);
});

// Item 9: the plist's EnvironmentVariables are exactly buySchedule's cronEnv, in order.
test('the plist EnvironmentVariables equal the cron environment', () => {
  const env = { PATH: okxDir(), HOME: '/Users/x', AVGKEEPER_HOME: '/tmp/ak h', ...OWNER };
  const s = buySchedule(env, { profile: 't' }, at1005);
  const l = launchdConfig(env, { profile: 't' }, at1005, '/Users/real');
  const block = /<key>EnvironmentVariables<\/key>\n\t<dict>\n([\s\S]*?)\n\t<\/dict>/.exec(l.plist)[1];
  const pairs = [...block.matchAll(/<key>([^<]+)<\/key>\n\t\t<string>([^<]*)<\/string>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, s.cronEnv);
  assert.ok(pairs.length >= 4);
});

// Review finding (schedule.mjs:139): no test pinned ProgramArguments or the two log-path keys directly. A plist
// with a wrong ProgramArguments (missing --profile, say) would have every launchd run do nothing or crash, and
// missing log paths would send a crash trace nowhere status or doctor ever reads.
test('the plist\'s ProgramArguments and log paths are exactly what buySchedule computes', () => {
  const env = { PATH: okxDir(), HOME: '/Users/x' };
  const s = buySchedule(env, { profile: 't' }, at1005);
  const l = launchdConfig(env, { profile: 't' }, at1005, '/Users/real');
  const argsBlock = /<key>ProgramArguments<\/key>\n\t<array>\n([\s\S]*?)\n\t<\/array>/.exec(l.plist)[1];
  const progArgs = [...argsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(progArgs, [s.node, s.script, 'buy', '--profile', 't']);
  const outPath = /<key>StandardOutPath<\/key>\n\t<string>([^<]*)<\/string>/.exec(l.plist)[1];
  const errPath = /<key>StandardErrorPath<\/key>\n\t<string>([^<]*)<\/string>/.exec(l.plist)[1];
  assert.equal(outPath, s.logPath);
  assert.equal(errPath, s.logPath);
});

test('a demo plan\'s plist ProgramArguments include --demo', () => {
  const env = { PATH: okxDir(), HOME: '/Users/x' };
  const s = buySchedule(env, { profile: 't', demo: true }, at1005);
  const l = launchdConfig(env, { profile: 't', demo: true }, at1005, '/Users/real');
  const argsBlock = /<key>ProgramArguments<\/key>\n\t<array>\n([\s\S]*?)\n\t<\/array>/.exec(l.plist)[1];
  const progArgs = [...argsBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(progArgs, [s.node, s.script, 'buy', '--profile', 't', '--demo']);
});

test('the load and remove commands quote a plist path with a space', () => {
  const l = launchdConfig({ PATH: okxDir(), HOME: '/Users/x' }, { profile: 't' }, at1005, '/Users/my home');
  assert.equal(l.load, "launchctl bootstrap gui/$(id -u) '/Users/my home/Library/LaunchAgents/com.avgkeeper.buy.t.plist'");
  assert.deepEqual(l.remove, [
    'launchctl bootout gui/$(id -u)/com.avgkeeper.buy.t',
    "rm '/Users/my home/Library/LaunchAgents/com.avgkeeper.buy.t.plist'",
  ]);
  assert.deepEqual(l.remove, launchdRemoveLines({ profile: 't' }, '/Users/my home'));
});

// Finding 10 of the 2026-09-27 release-readiness review: the removal commands were rebuilt by hand in stop, in
// doctor's after-stop branch and in launchdConfig, so one edit could leave two surfaces printing different commands
// for the same schedule. One writer each now, in schedule.mjs; this counts the writers in every script's code.
test('the launchd and crontab removal wording each has exactly one writer in the scripts', () => {
  const dir = path.join(path.dirname(ENTRY_SCRIPT));
  const code = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => withoutComments(fs.readFileSync(path.join(dir, f), 'utf8'))).join('\n');
  assert.equal(code.split('launchctl bootout').length - 1, 1, 'launchctl bootout');
  assert.equal(code.split('delete the AvgKeeper lines').length - 1, 1, 'the crontab removal sentence');
});

// Finding 12 of the 2026-09-27 release-readiness review: doctor ran preflight (okx CLI and OKX calls) before its
// removal branch, so a key OKX deleted after 14 idle days (which the key guide warns happens once stop leaves
// nothing calling it) or a missing okx CLI ended doctor before it printed the commands. They come from local facts.
// Review finding (buy.mjs:368, schedule.mjs:324): doctor's own exit code while a plan is still running (not
// stopped) was untested; the matching "no plan" branch's exit code is (line 266), but this later return (after
// doctor has printed the full schedule for a running plan) was not.
test('doctor exits 1 on a FAIL while a plan still runs, after printing the schedule', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const inner = ctx.okx.json;
  ctx.okx.json = async (args, call) => {
    if (args.join(' ') === 'account config') throw new OkxError('Error: Invalid OK-ACCESS-KEY', 'auth');
    return inner(args, call);
  };
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 1);
  assert.ok(text(ctx).includes('FAIL:'), text(ctx));
  assert.match(text(ctx), /Schedule: AvgKeeper wakes every day at /);
});

test('after stop, doctor still prints the removal commands when OKX refuses the key', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await stopVerb(ctx, { profile: 't' });
  leftoverPlist(ctx);
  const inner = ctx.okx.json;
  ctx.okx.json = async (args, call) => {
    if (args.join(' ') === 'account config') throw new OkxError('Error: Invalid OK-ACCESS-KEY', 'auth');
    return inner(args, call);
  };
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 1);
  assert.ok(ctx.lines.includes("FAIL: OKX did not accept API key t (Invalid OK-ACCESS-KEY). Check this key on the OKX website; if it was deleted, make a new one and save it yourself with okx config init."), text(ctx));
  const [bootout, rm] = launchdRemoveLines({ profile: 't' }, ctx.realHome);
  assert.ok(ctx.lines.includes(`If you used launchd, run both: ${bootout}, then ${rm}.`), text(ctx));
  assert.ok(ctx.lines.includes('If you used crontab, delete the AvgKeeper lines from your crontab yourself (crontab -e): the "# avgkeeper" comment and the line under it.'), text(ctx));
});

test('after stop, doctor still prints the removal commands with no okx CLI at all', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  await stopVerb(ctx, { profile: 't' });
  leftoverPlist(ctx);
  ctx.okx = {
    raw: async () => { throw new OkxError('could not start okx: spawn okx ENOENT', 'missing'); },
    json: async () => { throw new OkxError('could not start okx: spawn okx ENOENT', 'missing'); },
  };
  ctx.lines.length = 0;
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 1);
  assert.ok(ctx.lines.includes(`FAIL: ${NO_CLI_LINE}`), text(ctx));
  assert.ok(ctx.lines.some((l) => l.startsWith('If you used launchd, run both: launchctl bootout ')), text(ctx));
});

test('doctor names a saved launchd plist for this profile even with no ledger at all', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  ctx.realHome = tmpDir('ak-home-');
  const plistPath = launchdPlistPath({ profile: 't', demo: false }, ctx.realHome);
  ctx.sched.files.set(plistPath, '<plist/>\n');
  assert.equal(await doctorVerb(ctx, { profile: 't' }), 0);
  const t = text(ctx);
  assert.ok(t.includes(`No plan is on record for profile t, but a launchd plist for it is still saved at ${plistPath}.`), t);
  const [bootout, rm] = launchdRemoveLines({ profile: 't' }, ctx.realHome);
  assert.ok(ctx.lines.includes(`If you used launchd, run both: ${bootout}, then ${rm}.`), t);
  assert.ok(!t.includes('No plan yet'), t);
});

// Items 1 and 4: doctor names a stale buy lock and a time zone change with the same sentences buy or status use.
// Item 6 of the 2026-09-26 review: doctor only reads the lock, so it uses the read-only form, never "could not buy".
test('doctor names a stale buy lock read-only and a time zone change', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  const old = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(f, old, old);
  ctx.timeZone = 'Asia/Tokyo';
  await doctorVerb(ctx, { profile: 't' });
  const t = text(ctx);
  assert.match(t, /The buy lock from \d{4}-\d\d-\d\dT\d\d:\d\dZ is still held \(another AvgKeeper run, or one that crashed\)\./);
  assert.ok(t.includes(`If no AvgKeeper run is working, delete ${ctx.store.home}/buy-t-live.lock.`), t);
  assert.doesNotMatch(t, /could not buy/);
  assert.ok(ctx.lines.includes('WARNING: this plan was made in Europe/Istanbul, but this Mac is now on Asia/Tokyo. The schedule fires at machine time, so make a new plan with AVGPLAN, which reinstalls the schedule.'));
});

test('smoke fails on a non-zero exit and prints the command to rerun it', async () => {
  const ctx = await planned({ ...OWNER, PATH: okxDir(), HOME: '/Users/x' });
  ctx.runChild = async () => ({ code: 1, stdout: '', stderr: 'REFUSED: something\n' });
  assert.equal(await smokeVerb(ctx, { profile: 't' }), 1);
  assert.match(text(ctx), /FAIL: the buy exited 1 under cron's environment: REFUSED: something/);
  assert.match(text(ctx), /\/usr\/bin\/env -i /);
  assert.ok(!kinds(ctx).includes('buy_smoke'));
});

test('shWord quotes only what needs quoting', () => {
  assert.equal(shWord('/usr/bin/node'), '/usr/bin/node');
  assert.equal(shWord("/a b/c'd"), "'/a b/c'\\''d'");
});
