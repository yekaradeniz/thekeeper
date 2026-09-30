// avgkeeper/scripts/schedule.mjs
// The user's schedule. AvgKeeper installs nothing and edits no crontab: doctor prints the line and the plist, the
// user installs one, buy --smoke proves the printed line runs. The shapes follow GridKeeper's verbs.mjs, ledger-view.mjs and check.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  parseAt, parseHourlyAt, parseCadence, lastRunLine, missingPeriodsWarning,
} from './period.mjs';
import {
  isOwnerTest, OWNER_TEST_ENV, CLI_INSTALL, preflight, builderDisclosure, keyInactivityWarning, failureLine,
} from './guards.mjs';
import {
  activePlan, tornWarning, noPlanTornCaveat, staleLockLine, timeZoneWarning, haltedLine, waitingLine, everHadPlan,
} from './planview.mjs';
import { readConfigSafe, notifyStatusLine } from './notify.mjs';
import {
  mailConfig, mailStatus, mailSubject, mailLine, mailReachLine, MAIL_OFF_LINE,
} from './mail.mjs';
import { planLine } from './cards.mjs';
import { DRY_SUMMARY } from './buy.mjs';
import { resolveAvgkeeperHome, displayHomePath } from './store.mjs';
import { logPathIn, logStatusLines } from './runlog.mjs';
import {
  ENTRY_SCRIPT, shWord, cronWord, stableNode, commandText,
} from './cmdtext.mjs';

// Re-exported unchanged: cmdtext.mjs is the one reader (a leaf module, so mail.mjs and manage.mjs can also import
// commandText from it with no import cycle back through this file's own import of mail.mjs above).
export {
  ENTRY_SCRIPT, shWord, cronWord, stableNode, commandText,
};
export const CRON_PATH_TAIL = '/usr/bin:/bin';
export const SMOKE_TIMEOUT_MS = 300000;
export const SMOKE_NOTIFY_TIMEOUT_MS = 10000;
export const SMOKE_LINE = 'AvgKeeper test: the scheduled buy can reach you.';
export const MAIL_SMOKE_LINE = 'AvgKeeper mail test: the scheduled buy can reach you by mail.';

const isFile = (p, mode) => {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (mode !== undefined) fs.accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
};

export function resolveOkx(env = {}) {
  if (env.AVGKEEPER_OKX_BIN) {
    const p = path.resolve(env.AVGKEEPER_OKX_BIN);
    return isFile(p) ? p : null;
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    const p = dir ? path.resolve(dir, 'okx') : '';
    if (p && isFile(p, fs.constants.X_OK)) return p;
  }
  return null;
}

export function buySchedule(env, o, plan, via = 'cron') {
  const okx = resolveOkx(env);
  if (!okx) {
    return {
      why: env.AVGKEEPER_OKX_BIN
        ? `AVGKEEPER_OKX_BIN is set to ${env.AVGKEEPER_OKX_BIN}, which is not a file, so ${via} cannot run the buy.`
        : `no okx on PATH, so ${via} cannot run the buy. Install the okx CLI: ${CLI_INSTALL}`,
    };
  }
  // Section 10: an hourly plan's cron is 'MM * * * *' (no hour, day, month or weekday field), so it fires every
  // hour; every other cadence keeps the plan's own hour and minute, unchanged.
  const cadence = parseCadence(plan.cadence);
  const hourly = Boolean(cadence && cadence.kind === 'hour');
  const at = hourly ? parseHourlyAt(plan.at) : parseAt(plan.at);
  const hour = hourly ? null : Math.floor(at / 60);
  const minute = hourly ? at : at % 60;
  const home = env.HOME || os.homedir();
  const node = stableNode(env);
  const cronDirs = [...new Set([path.dirname(node), path.dirname(okx), ...CRON_PATH_TAIL.split(':')])];
  const cronPath = cronDirs.join(':');
  const akHome = env.AVGKEEPER_HOME ? path.resolve(env.AVGKEEPER_HOME) : null;
  const cronEnv = [
    ['HOME', home],
    ['PATH', cronPath],
    ...(akHome ? [['AVGKEEPER_HOME', akHome]] : []),
    ...(env.AVGKEEPER_OKX_BIN ? [['AVGKEEPER_OKX_BIN', okx]] : []),
    ...(isOwnerTest(env) ? [[OWNER_TEST_ENV, '1']] : []),
    ['AVGKEEPER_SCHEDULED', '1'],
  ];
  const args = ['buy', '--profile', o.profile, ...(o.demo ? ['--demo'] : [])];
  const cronTime = hourly ? `${minute} * * * *` : `${minute} ${hour} * * *`;
  // Item 4 of the 2026-09-27 release audit: a scheduled run's own stdout and stderr went nowhere before this.
  // storeHome is exactly what this same run resolves as its AvgKeeper home once it starts (resolveAvgkeeperHome,
  // store.mjs's own homeDir formula), so the log lands where status and doctor already know to look for it
  // (runlog.mjs). The redirect is appended to the printed line itself, never to cronEnv or args, so buy --smoke
  // (which spawns from those two, never from this string) is untouched by it.
  const storeHome = resolveAvgkeeperHome(home, akHome);
  const logPath = logPathIn(storeHome, o);
  const line = `${cronTime} ${cronEnv.map(([k, v]) => `${k}=${cronWord(v)}`).join(' ')} ${cronWord(node)} ${cronWord(ENTRY_SCRIPT)} ${args.join(' ')} >> ${cronWord(logPath)} 2>&1`;
  return {
    okx, node, script: ENTRY_SCRIPT, cronEnv, line, via, hour, minute, hourly, args, storeHome, logPath,
  };
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlString = (s) => `<string>${xmlEscape(s)}</string>`;
export const launchdLabel = (o) => `com.avgkeeper.buy.${o.profile}${o.demo ? '.demo' : ''}`;

// The plist path alone, with no dependency on resolving the okx CLI: stop (manage.mjs) needs to name this file even
// when okx cannot be found right now, and doctor's own launchdConfig below reads it from here too, one formula for
// both (rule 3, one fact one reader).
export const launchdPlistPath = (o, realHome = os.homedir()) => path.join(realHome, 'Library', 'LaunchAgents', `${launchdLabel(o)}.plist`);

// Finding 10 of the 2026-09-27 release-readiness review: the commands that take a schedule out had three authors
// (launchdConfig, stop, doctor's after-stop branch), so one edit could leave two surfaces giving the user different
// commands for the same schedule. One writer each now. Unloading alone leaves the plist file, which launchd loads
// again at the next login, so the rm is part of the same fact. Local facts only: no okx CLI and no OKX call.
export function launchdRemoveLines(o, realHome = os.homedir()) {
  const plist = shWord(launchdPlistPath(o, realHome));
  return [`launchctl bootout gui/$(id -u) ${plist}`, `rm ${plist}`];
}
export const CRONTAB_REMOVE = 'delete the AvgKeeper line from your crontab yourself (crontab -e)';
// The removal sentences stop and doctor print once no plan needs the schedule: launchd's two commands on macOS,
// the crontab edit everywhere.
export function removeScheduleLines(o, platform, realHome) {
  const [bootout, rm] = launchdRemoveLines(o, realHome);
  return [
    ...(platform === 'darwin' ? [`If you used launchd, run both: ${bootout}, then ${rm}.`] : []),
    `If you used crontab, ${CRONTAB_REMOVE}.`,
  ];
}

// StartCalendarInterval runs a job missed during sleep at the next wake; cron skips it.
export function launchdConfig(env, o, plan, realHome = os.homedir()) {
  const s = buySchedule(env, o, plan, 'launchd');
  if (s.why) return s;
  const label = launchdLabel(o);
  const plistPath = launchdPlistPath(o, realHome);
  const progArgs = [s.node, s.script, ...s.args];
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${xmlString(label)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...progArgs.map((a) => `\t\t${xmlString(a)}`),
    '\t</array>',
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    ...s.cronEnv.flatMap(([k, v]) => [`\t\t<key>${k}</key>`, `\t\t${xmlString(v)}`]),
    '\t</dict>',
    // Item 4 of the 2026-09-27 release audit: the same file the cron line's own `>> ... 2>&1` redirect writes to
    // (s.logPath, from buySchedule above), so a launchd run's output is never lost either. launchd appends to an
    // existing file here rather than truncating it, the same as the cron redirect.
    '\t<key>StandardOutPath</key>',
    `\t${xmlString(s.logPath)}`,
    '\t<key>StandardErrorPath</key>',
    `\t${xmlString(s.logPath)}`,
    '\t<key>StartCalendarInterval</key>',
    '\t<dict>',
    // Section 10: Minute only for an hourly plan, so it fires every hour; every other cadence keeps Hour too.
    ...(s.hourly ? [] : ['\t\t<key>Hour</key>', `\t\t<integer>${s.hour}</integer>`]),
    '\t\t<key>Minute</key>',
    `\t\t<integer>${s.minute}</integer>`,
    '\t</dict>',
    '\t<key>RunAtLoad</key>',
    '\t<false/>',
    '</dict>',
    '</plist>',
  ].join('\n');
  return {
    ...s,
    label,
    plistPath,
    plist,
    load: `launchctl bootstrap gui/$(id -u) ${shWord(plistPath)}`,
    remove: launchdRemoveLines(o, realHome),
  };
}

// detached: the child leads its own process group and a timeout kills the whole group, the same contract
// notify.mjs's runShellPiped gives the scheduled run. Smoke uses it for the user's notify and mail commands, so a
// wrapper's own children (`sh -c "a | b"`) cannot finish sending after smoke already said it failed. The dry-run
// buy itself is not detached, so Ctrl-C in the terminal still stops it.
export function runChild(file, args, { input = '', timeoutMs = SMOKE_TIMEOUT_MS, detached = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], detached });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        // A negative pid names the child's whole process group, which only a detached child leads.
        if (detached) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const lastLine = (r) => {
  const t = String(r.stderr || '').trim() ? r.stderr : r.stdout;
  const lines = String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '(no output)';
};
const firstLine = (t) => {
  const lines = String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[0] : '(no output)';
};

export async function doctorVerb(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const platform = ctx.platform || process.platform;
  // Finding 12 of the 2026-09-27 release-readiness review: preflight calls the okx CLI and OKX, and a failure there
  // (a key OKX deleted after 14 idle days, no okx CLI at all) used to end doctor before the removal commands below,
  // which need only local facts. It is a FAIL line now, and doctor goes on.
  let pre;
  try {
    pre = await preflight(ctx, call);
  } catch (e) {
    pre = { refusals: [{ msg: failureLine(e, call.profile) }], ownerTest: isOwnerTest(ctx.env), ip: null };
  }
  if (pre.refusals.length) for (const r of pre.refusals) ctx.out(`FAIL: ${r.msg.replace(/^REFUSED: /, '')}`);
  else ctx.out(`PASS: okx CLI, OKX Global profile ${call.profile}, and an API key that can trade and cannot withdraw.`);
  ctx.out(builderDisclosure(pre.ownerTest));
  const { config, line } = readConfigSafe(ctx.store);
  if (line) ctx.out(`FAIL: ${line}`);
  else ctx.out(notifyStatusLine(config));
  const ledger = ctx.store.readLedger();
  const mail = mailStatus(ctx.store, ledger, call);
  ctx.out(mail.line);
  if (mail.pending) ctx.out(`Mail waiting to be sent: ${mail.pending}. See them: ${commandText(`mail --pending --profile ${call.profile}${call.demo ? ' --demo' : ''}`)}.`);
  const warning = tornWarning(ledger, ctx.store.home);
  if (warning) ctx.out(warning);
  const stale = staleLockLine(ctx.store, call, { readOnly: true });
  if (stale) ctx.out(stale);
  const plan = activePlan(ledger, call);
  if (!plan) {
    // Item 3 of the 2026-09-27 release audit: a plan that was stopped still gets removal instructions here,
    // instead of a bare "No plan yet" that reads as if none had ever run and leaves an installed schedule with
    // nothing telling the user how to take it out. Finding 12 of the release-readiness review: a launchd plist
    // still saved for this profile gets them too, even with an empty or deleted ledger.
    const plistPath = launchdPlistPath(call, ctx.realHome);
    // Review finding (manage.mjs:199 area, later): the same caveat status and holdings now carry, for the same
    // reason: a torn line could have been the very plan_active this profile never showed as running. Printed as
    // its own line for the two branches below (each ends its own sentence in a colon, introducing the removal
    // commands that follow), appended in place for the plain "No plan yet" sentence.
    const caveat = noPlanTornCaveat(ledger);
    if (everHadPlan(ledger, call)) {
      ctx.out('No plan is running now (it was stopped or replaced). If a schedule line is still installed from an earlier plan, take it out so it stops firing for nothing:');
      if (caveat) ctx.out(caveat.trim());
    } else if (platform === 'darwin' && fs.existsSync(plistPath)) {
      ctx.out(`No plan is on record for profile ${call.profile}, but a launchd plist for it is still saved at ${plistPath}. Take the schedule out so it stops firing for nothing:`);
      if (caveat) ctx.out(caveat.trim());
    } else {
      ctx.out(`No plan yet. The schedule line depends on the plan time, so make a plan first.${caveat}`);
      return pre.refusals.length ? 1 : 0;
    }
    for (const l of removeScheduleLines(call, platform, ctx.realHome)) ctx.out(l);
    return pre.refusals.length ? 1 : 0;
  }
  ctx.out(lastRunLine(ledger, plan));
  const missing = missingPeriodsWarning(ledger, plan, ctx.now(), Boolean(stale));
  if (missing) ctx.out(missing);
  for (const l of logStatusLines(ctx.store.home, call, plan.timeZone)) ctx.out(l);
  const keyWarning = keyInactivityWarning(pre.ip, parseCadence(plan.cadence));
  if (keyWarning) ctx.out(keyWarning);
  const tz = timeZoneWarning(plan, ctx.timeZone);
  if (tz) ctx.out(tz);
  const halted = haltedLine(plan);
  if (halted) ctx.out(halted);
  const waiting = waitingLine(ledger, plan);
  if (waiting) ctx.out(waiting);
  // Review finding (schedule.mjs:284, later): a halted plan buys nothing until a new one is made (haltedLine just
  // above already says so), so inviting the user to install a schedule line and then "prove it" with
  // buy --smoke sent them straight to a command smoke itself is certain to refuse ("FAIL: the plan is halted").
  if (plan.halted) {
    // Review finding (schedule.mjs:292, later): haltedLine, printed just above, already ends "Nothing is bought
    // until you make a new plan."; repeating that exact clause here said the same thing twice in two lines.
    ctx.out('Make one first, then run doctor again for its schedule line.');
    ctx.out('If a schedule line from before is still installed, it now buys nothing. To take it out:');
    for (const l of removeScheduleLines(call, platform, ctx.realHome)) ctx.out(l);
    return pre.refusals.length ? 1 : 0;
  }
  const env = ctx.env || {};
  const cron = buySchedule(env, o, plan);
  if (cron.why) {
    ctx.out(`FAIL: ${cron.why}`);
    return 1;
  }
  for (const risk of scheduleRisks(cron, { platform, realHome: ctx.realHome })) ctx.out(risk);
  const planCadence = parseCadence(plan.cadence);
  const planHourly = Boolean(planCadence && planCadence.kind === 'hour');
  const scheduleWord = planHourly
    ? `every hour at ${plan.at} machine time`
    : `daily at ${plan.at} machine time and buys only on the plan's buy days`;
  ctx.out(`Schedule: the buy runs ${scheduleWord}. Install one of these yourself.`);
  ctx.out('Option 1, crontab (skips a run while the Mac sleeps). Run crontab -e and add this line:');
  ctx.out(cron.line);
  if (platform === 'darwin') {
    const l = launchdConfig(env, o, plan, ctx.realHome);
    ctx.out(`Option 2, launchd (runs at the next wake after sleep). Save this as ${l.plistPath}:`);
    ctx.out(l.plist);
    ctx.out(`Then load it: ${l.load}`);
    const plistDiff = savedPlistDiffWarning(l.plistPath, l.plist);
    if (plistDiff) ctx.out(plistDiff);
    // Unloading alone (l.remove, launchctl bootout) leaves the plist file on disk, and launchd loads any file in
    // LaunchAgents again at your next login, so an active plan would quietly resume buying (item 3 of the
    // 2026-09-27 release audit). Removing the file too is what actually ends the schedule; ending the plan itself
    // is stop's own job, named here so the two are never confused.
    ctx.out('To remove it later, run both of these (unloading alone leaves the file, which loads again at your next login):');
    for (const line of l.remove) ctx.out(line);
    ctx.out('That only stops the schedule from firing. Ask your agent for stop to end the plan itself.');
  }
  // Item 4 of the 2026-09-27 release audit: named once, here, so a user who never reads the redirect at the end of
  // the crontab line or the plist's own StandardOutPath still knows where a scheduled run's own output goes. Later
  // item L2 of the release-readiness review: notify, mail, status and doctor show parts of that output too.
  ctx.out(`Either way, each run's full output is also appended to ${cron.logPath}; status and doctor show its last lines when the last one does not read like an ordinary finish.`);
  // Not commandText: this node has to be the one the schedule line itself names (cron.node, resolved from the
  // schedule's own env), so smoke proves the exact interpreter cron or launchd will use, not this session's.
  const smokeArgs = (launchd) => ['buy', '--smoke', ...(launchd ? ['--launchd'] : []), '--profile', o.profile, ...(o.demo ? ['--demo'] : [])];
  const proveCmd = (launchd) => `${shWord(cron.node)} ${shWord(cron.script)} ${smokeArgs(launchd).join(' ')}`;
  ctx.out(`Then prove it: ${proveCmd(false)}`);
  if (platform === 'darwin') ctx.out(`With launchd: ${proveCmd(true)}`);
  ctx.out('If you change the plan time later, run doctor again and replace the line.');
  return pre.refusals.length ? 1 : 0;
}

// Item 9 of the 2026-09-27 release audit: what can quietly break a schedule that works today, named right where
// doctor prints the line the user is about to install. Ported from GridKeeper's verbs.mjs scheduleRisks (read for
// the idea; this is AvgKeeper's own code and words, no shared file). macOS privacy protection can keep a scheduled
// process from reading files under ~/Desktop, ~/Documents and ~/Downloads unless it was granted access, which a
// smoke run from this terminal cannot show since it inherits this terminal's own grant. A node or okx path with a
// version number in it (nvm, or Homebrew's Cellar) is one the next upgrade removes, after which cron or launchd
// fails every run with no heartbeat. realHome is the logged-in user's real home, set only by the real context
// (never a test's own fixture), so a test run never judges the machine it happens to run on.
const VERSIONED_PATH = /\/v?\d+\.\d+\.\d+(?:[/_-]|$)|\/Cellar\//;
const PRIVACY_FOLDERS = ['Desktop', 'Documents', 'Downloads'];
function tildeOf(p, realHome) {
  return realHome && (p === realHome || p.startsWith(`${realHome}${path.sep}`)) ? `~${p.slice(realHome.length)}` : p;
}
export function scheduleRisks(cron, { platform, realHome } = {}) {
  const out = [];
  if (platform === 'darwin' && realHome) {
    for (const p of [cron.script, cron.storeHome].filter(Boolean)) {
      const folder = PRIVACY_FOLDERS.find((f) => p === path.join(realHome, f) || p.startsWith(`${path.join(realHome, f)}${path.sep}`));
      if (folder) out.push(`WARNING: ${tildeOf(p, realHome)} is under ~/${folder}, where macOS can keep a scheduled run from reading it, and a test from this terminal cannot show that. Keep AvgKeeper and its state outside ~/Desktop, ~/Documents and ~/Downloads.`);
    }
  }
  for (const p of [cron.node, cron.okx].filter(Boolean)) {
    if (VERSIONED_PATH.test(p)) out.push(`The schedule names ${tildeOf(p, realHome)}, which has a version number in it: after you upgrade node or the okx CLI, run doctor again and reinstall the schedule line it prints.`);
  }
  return out;
}

// The saved plist at path, compared with the one doctor prints now. Read only. Returns a FAIL reason or null.
function savedPlistProblem(form) {
  let saved;
  try {
    saved = fs.readFileSync(form.plistPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return `the launchd plist is not saved yet at ${form.plistPath}. Save the plist doctor prints there and load it.`;
    return `the launchd plist at ${form.plistPath} could not be read (${e.code || e.message}).`;
  }
  // An editor's trailing newline is not a difference; anything else is.
  if (saved.trimEnd() !== form.plist.trimEnd()) return 'the saved plist differs from the one doctor prints now; save the new one and load it again.';
  return null;
}

// Item 9 of the 2026-09-27 release audit: doctor's own read-only compare, run every time doctor does, unlike
// smoke --launchd's savedPlistProblem above, which is a FAIL only when the user asks for it and treats "not saved
// yet" as the failure (correct for a first-time install proof). Here, no file yet is not a warning at all: the user
// has simply not saved one, which is the normal state before following doctor's own instructions. A warning fires
// only once a plist IS saved and no longer matches what doctor prints now (the plan's time changed since it was
// saved, say): the file on disk, unreloaded, would still fire the old schedule.
export function savedPlistDiffWarning(plistPath, plist) {
  let saved;
  try {
    saved = fs.readFileSync(plistPath, 'utf8');
  } catch {
    return null;
  }
  if (saved.trimEnd() === plist.trimEnd()) return null;
  return `WARNING: the plist already saved at ${plistPath} differs from the one printed above; save the new one and load it again.`;
}

// smoke proves that the line doctor prints runs under the schedule's own environment, as a dry run. It cannot see
// the crontab or what launchd has loaded, so it never says the line is installed. With --launchd it also checks
// that the saved plist file matches the one doctor prints now.
export async function smokeVerb(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const { config, line } = readConfigSafe(ctx.store);
  if (line) {
    ctx.out(`FAIL: ${line}`);
    return 1;
  }
  const plan = activePlan(ctx.store.readLedger(), call);
  if (!plan) {
    ctx.out('FAIL: no plan yet, so there is no schedule to test. Make a plan first.');
    return 1;
  }
  if (plan.halted) {
    ctx.out(`FAIL: the plan is halted: ${plan.halted}`);
    return 1;
  }
  const platform = ctx.platform || process.platform;
  if (o.launchd && platform !== 'darwin') {
    ctx.out(`FAIL: the launchd option is macOS only; this host reports ${platform}.`);
    return 1;
  }
  const env = ctx.env || {};
  const form = o.launchd ? launchdConfig(env, o, plan, ctx.realHome) : buySchedule(env, o, plan);
  if (form.why) {
    ctx.out(`FAIL: ${form.why}`);
    return 1;
  }
  if (o.launchd) {
    const problem = savedPlistProblem(form);
    if (problem) {
      ctx.out(`FAIL: ${problem}`);
      return 1;
    }
  }
  const words = form.cronEnv.map(([k, v]) => `${k}=${v}`);
  const argv = [...words, form.node, form.script, 'buy', '--dry-run', '--profile', o.profile, ...(o.demo ? ['--demo'] : [])];
  const cmd = `/usr/bin/env -i ${argv.map(shWord).join(' ')}`;
  ctx.out(`Testing the buy the way ${form.via} will run it, as a dry run that sends nothing.`);
  const r = await ctx.runChild('/usr/bin/env', ['-i', ...argv]);
  if (r.timedOut) {
    ctx.out(`FAIL: the buy did not finish within ${SMOKE_TIMEOUT_MS / 1000} seconds under ${form.via}'s environment.`);
    ctx.out(`To run the same test yourself: ${cmd}`);
    return 1;
  }
  // Finding 34 remaining: DRY_SUMMARY alone is also what buy --dry-run's own no-plan branch prints (buy.mjs), so a
  // schedule environment that cannot see this plan at all (AVGKEEPER_HOME pointing at a different or missing
  // store) still passed smoke. planLine(plan) is this run's own plan, in the exact words the child's own dry run
  // would print it if, and only if, it read the same plan back; requiring it too proves the child saw THIS plan,
  // not merely that some buy --dry-run ran to completion.
  const out = String(r.stdout || '');
  if (r.code !== 0 || !out.includes(DRY_SUMMARY)) {
    ctx.out(`FAIL: the buy exited ${r.code} under ${form.via}'s environment: ${lastLine(r)}`);
    ctx.out(`To run the same test yourself: ${cmd}`);
    return 1;
  }
  // Review finding (schedule.mjs:449, should): a child that exits 0 with an ordinary-looking dry run, but for a
  // different plan (an AVGKEEPER_HOME or HOME mismatch), used to fall into the generic "the buy exited 0" sentence
  // above, with the dry run's own success line quoted back as if it were the failure. The checked cause here is
  // narrower than that: the child saw a plan, just not this one, and storeHome (resolveAvgkeeperHome, the same
  // formula this schedule line's own HOME and AVGKEEPER_HOME feed) names the store it actually read. Mutation
  // review (2026-09-28): this same check used to also sit in the generic clause above, as `|| !out.includes(
  // planLine(plan))`, but the exit-code and DRY_SUMMARY check there already returns first whenever r.code === 0 and
  // DRY_SUMMARY is present, so that copy could never fire; kept in exactly one place now (rule 3, one fact one
  // reader).
  if (!out.includes(planLine(plan))) {
    ctx.out(`FAIL: the dry run under ${form.via}'s environment did not see this plan; it read a different AvgKeeper store, or none, at ${displayHomePath(form.storeHome)} (it said: ${firstLine(out)}).`);
    ctx.out(`To run the same test yourself: ${cmd}`);
    return 1;
  }
  // Review findings (schedule.mjs:457, should): the child's own dry run already checks its resolved time zone
  // against the plan's own and prints the WARNING when they differ (buy.mjs's timeZoneWarning), but a mismatch
  // still let the ordinary DRY_SUMMARY and planLine checks above pass, since the dry run only warns and keeps
  // going. cron and launchd never see TZ, so a plan made from a shell with TZ exported is the realistic trigger:
  // every scheduled run then fires hours away from the plan's own buy time, or never at all.
  const tzPrefix = `WARNING: this plan was made in ${plan.timeZone}, but this Mac is now on `;
  if (out.includes(tzPrefix)) {
    const tzLine = out.split('\n').find((l) => l.startsWith(tzPrefix)) || tzPrefix;
    ctx.out(`FAIL: ${form.via}'s own environment reads a different time zone than the plan was made in. ${tzLine}`);
    ctx.out('If the plan was made from a shell with TZ set, unset it and make the plan again.');
    ctx.out(`To run the same test yourself: ${cmd}`);
    return 1;
  }
  ctx.out(`PASS: the ${form.via} line doctor prints runs: the buy ran as a dry run under ${form.via}'s environment. This does not check that the line is installed.`);
  if (config.notify) {
    const n = await ctx.runChild('/usr/bin/env', ['-i', ...words, '/bin/sh', '-c', config.notify], { input: `${SMOKE_LINE}\n`, timeoutMs: SMOKE_NOTIFY_TIMEOUT_MS, detached: true });
    if (n.timedOut || n.code !== 0) {
      ctx.out(`WARNING: your notify command ${n.timedOut ? 'did not finish in time' : `exited ${n.code}`} under ${form.via}'s environment, so the buy cannot reach you.`);
      return 1;
    }
    ctx.out(`Sent to your notify command: ${SMOKE_LINE}`);
  } else {
    // Review finding (schedule.mjs:244): "will show only in status" is false whenever mail is on. New regression
    // (schedule.mjs:449): the pointer named a line this screen never prints, and named it with no mail.command;
    // mailReachLine states the fact itself instead, agreeing with the "waits in mail --pending" sentence below.
    const reach = mailReachLine(config);
    ctx.out(reach
      ? `No notify command is set. ${reach}. It also shows in status.`
      : 'No notify command is set, so a skipped or halted buy will show only in status.');
  }
  // spec section 9, "Surfaces": buy --smoke sends a test notice through mail.command under the schedule
  // environment when one is set, the same way it already proves the notify command above. A failure is a WARNING
  // that fails smoke (returns 1, the same as a failed notify test) and writes nothing, exactly like every other
  // failure in this function: smoke only ever reads and runs child processes, never the ledger or config.
  const { command: mailCmd, to: mailTo } = mailConfig(config);
  if (mailCmd) {
    const subject = mailSubject({ profile: o.profile, demo: o.demo, fact: 'mail smoke test' });
    const mn = await ctx.runChild('/usr/bin/env', ['-i', ...words, `AVGKEEPER_SUBJECT=${subject}`, `AVGKEEPER_NOTIFY_EMAIL=${mailTo || ''}`, '/bin/sh', '-c', mailCmd], { input: `${MAIL_SMOKE_LINE}\n`, timeoutMs: SMOKE_NOTIFY_TIMEOUT_MS, detached: true });
    if (mn.timedOut || mn.code !== 0) {
      ctx.out(`WARNING: your mail command ${mn.timedOut ? 'did not finish in time' : `exited ${mn.code}`} under ${form.via}'s environment, so a mail notice cannot reach you.`);
      return 1;
    }
    ctx.out(`PASS: a test mail notice reached your mail command: ${MAIL_SMOKE_LINE}`);
    // Review finding (schedule.mjs:453): the command working proves nothing about whether a real notice would ever
    // be prepared. Mail is off (level off, or no usable address) whenever mailLine says so, whatever the command
    // itself just did.
    if (mailLine(config) === MAIL_OFF_LINE) {
      ctx.out(`${MAIL_OFF_LINE} The command works, but no notice is prepared until an address and a level are set.`);
    }
  } else if (mailLine(config) === MAIL_OFF_LINE) {
    // Mail off prepares no notice at all, so nothing waits anywhere: say that, not where a notice would wait.
    ctx.out(MAIL_OFF_LINE);
  } else {
    ctx.out(`No mail command is set, so each mail notice waits in ${commandText(`mail --pending --profile ${o.profile}${o.demo ? ' --demo' : ''}`)} until you ask your agent to send it.`);
  }
  return 0;
}
