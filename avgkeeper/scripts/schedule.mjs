// avgkeeper/scripts/schedule.mjs
// The user's schedule. Since 2026-09-30 AvgKeeper installs its own entry on AVGPLAN and removes it on stop (see the
// end of this file); doctor reads it and, when it is missing or differs, prints the line and the plist to install
// by hand, and buy --smoke proves the printed line runs. The shapes follow GridKeeper's verbs.mjs, ledger-view.mjs and check.mjs.
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
  modeOf, activePlan, tornWarning, noPlanTornCaveat, staleLockLine, timeZoneWarning, haltedLine, waitingLine, everHadPlan,
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
  return [`launchctl bootout gui/$(id -u)/${launchdLabel(o)}`, `rm ${plist}`];
}
export const CRONTAB_REMOVE = 'delete the AvgKeeper lines from your crontab yourself (crontab -e): the "# avgkeeper" comment and the line under it';
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
    // setEncoding, not `+= chunk`: each Buffer chunk decoded alone turns a multi-byte character split across two reads
    // into U+FFFD, and a crontab read this way is written back to the user with their own text corrupted.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
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
  // Exit 1 whenever any FAIL line was printed above or below: the preflight refusals and this config line are the two
  // printed before the plan is read; the later ones return 1 at their own print.
  const failed = () => pre.refusals.length > 0 || Boolean(line);
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
    // The removal commands are printed only for an entry that is there or whose state could not be read: a
    // profile with nothing installed is told so, instead of being handed commands for nothing (rule 2, never state
    // what the code did not check).
    const entry = await readEntryPresence(ctx, call);
    const noEntry = `No AvgKeeper schedule entry is installed for profile ${call.profile} (${modeOf(call)}).`;
    const unreadable = entry.state === 'unknown' ? `AvgKeeper could not tell whether a schedule entry is installed (${entry.detail}). If one is, take it out so it stops firing for nothing:` : null;
    // Review finding (manage.mjs:199 area, later): the same caveat status and holdings now carry, for the same
    // reason: a torn line could have been the very plan_active this profile never showed as running. Printed as
    // its own line for the two branches below (each ends its own sentence in a colon, introducing the removal
    // commands that follow), appended in place for the plain "No plan yet" sentence.
    const caveat = noPlanTornCaveat(ledger);
    if (everHadPlan(ledger, call)) {
      if (entry.state === 'none') {
        ctx.out(`No plan is running now (it was stopped or replaced). ${noEntry}`);
        if (caveat) ctx.out(caveat.trim());
        return failed() ? 1 : 0;
      }
      ctx.out(entry.state === 'found'
        ? 'No plan is running now (it was stopped or replaced), but an AvgKeeper schedule entry from an earlier plan is still installed. Take it out so it stops firing for nothing:'
        : `No plan is running now (it was stopped or replaced). ${unreadable}`);
      if (caveat) ctx.out(caveat.trim());
    } else if (entry.state === 'found') {
      ctx.out(platform === 'darwin' && entry.plistSaved
        ? `No plan is on record for profile ${call.profile}, but a launchd plist for it is still saved at ${plistPath}. Take the schedule out so it stops firing for nothing:`
        : `No plan is on record for profile ${call.profile}, but an AvgKeeper schedule entry for it is still installed. Take it out so it stops firing for nothing:`);
      if (caveat) ctx.out(caveat.trim());
    } else if (entry.state === 'unknown') {
      ctx.out(`No plan yet: make one with AVGPLAN. ${unreadable}${caveat}`);
    } else {
      ctx.out(`No plan yet: make one with AVGPLAN. ${noEntry}${caveat}`);
      return failed() ? 1 : 0;
    }
    for (const l of removeScheduleLines(call, platform, ctx.realHome)) ctx.out(l);
    return failed() ? 1 : 0;
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
    ctx.out('Make a new plan with AVGPLAN; it replaces this schedule entry.');
    ctx.out('If a schedule line from before is still installed, it now buys nothing. To take it out:');
    for (const l of removeScheduleLines(call, platform, ctx.realHome)) ctx.out(l);
    return failed() ? 1 : 0;
  }
  const env = ctx.env || {};
  const cron = buySchedule(env, o, plan);
  if (cron.why) {
    ctx.out(`FAIL: ${cron.why}`);
    return 1;
  }
  for (const risk of scheduleRisks(cron, { platform, realHome: ctx.realHome })) ctx.out(risk);
  // AVGPLAN installs the entry itself (installSchedule); doctor only reads whether it is there and matches this plan,
  // and never writes. Installed: no install instructions, just the proof command.
  const state = await readScheduleState(ctx, call, plan);
  if (state.state === 'installed') {
    ctx.out(`Schedule: installed (${viaPhrase(state.via)}${state.byHand ? '; this crontab line was added by hand, not by AVGPLAN' : ''}). ${scheduleWakes(plan)}. Each run's full output is appended to ${cron.logPath}; status and doctor show its last lines when the last one does not read like an ordinary finish.`);
    // The entry matches the plan, but a second one next to it fires too: a problem, not a pass.
    const problems = state.problems || [];
    for (const p of problems) ctx.out(`FAIL: ${p}`);
    ctx.out(`To prove it runs under the schedule's own environment: ${shWord(cron.node)} ${shWord(cron.script)} ${['buy', '--smoke', ...(state.via === 'launchd' ? ['--launchd'] : []), '--profile', o.profile, ...(o.demo ? ['--demo'] : [])].join(' ')}`);
    ctx.out('If you change the plan time later, make the plan again with AVGPLAN and the entry is replaced.');
    return failed() || problems.length ? 1 : 0;
  }
  // unknown: the read itself failed, so neither "installed" nor "missing" is a fact. Said so, then the manual lines.
  const unknown = state.state === 'unknown' ? `AvgKeeper could not tell whether an entry is installed (${state.detail}). If none is, install` : null;
  const different = state.state === 'different';
  if (different) {
    ctx.out(`Schedule: an entry is installed (${viaPhrase(state.via)}) but it differs from this plan. Make the plan again with AVGPLAN, which replaces it.`);
    ctx.out(`Or install the plan's schedule by hand (${scheduleWakes(plan)}). Install one of these yourself.`);
  } else {
    ctx.out(`Schedule: ${scheduleWakes(plan)}. ${unknown || 'Install'} one of these yourself.`);
    ctx.out('Or ask your agent to make the plan again with AVGPLAN, which installs it.');
  }
  ctx.out(different
    ? 'Option 1, crontab (skips a run while the Mac sleeps). Run crontab -e, delete the old AvgKeeper lines (the "# avgkeeper" comment and the line under it), then add this line:'
    : 'Option 1, crontab (skips a run while the Mac sleeps). Run crontab -e and add this line:');
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
  return failed() ? 1 : 0;
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
    if (VERSIONED_PATH.test(p)) out.push(`The schedule names ${tildeOf(p, realHome)}, which has a version number in it: after you upgrade node or the okx CLI, make the plan again with AVGPLAN, which reinstalls the schedule.`);
  }
  return out;
}

// The saved plist at path, compared with the one doctor prints now. Read only. Returns a FAIL reason or null.
function savedPlistProblem(form) {
  let saved;
  try {
    saved = fs.readFileSync(form.plistPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return `the launchd plist is not saved yet at ${form.plistPath}. Make the plan again with AVGPLAN, which saves and loads it.`;
    return `the launchd plist at ${form.plistPath} could not be read (${e.code || e.message}).`;
  }
  // An editor's trailing newline is not a difference; anything else is.
  if (saved.trimEnd() !== form.plist.trimEnd()) return 'the saved plist differs from the one this plan needs; make the plan again with AVGPLAN, which replaces it.';
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
  ctx.out(`PASS: the ${form.via} schedule line runs: the buy ran as a dry run under ${form.via}'s environment. This does not check that the line is installed.`);
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

// ---------------------------------------------------------------------------------------------------------------
// The schedule entry AvgKeeper installs and removes itself (2026-09-30: AVGPLAN is the whole job). One place:
// plan --confirm installs, stop removes, doctor reads, all through the functions below (rule 3, one fact one
// reader). Every command goes through ctx.sched, never a real binary directly, so a test context that forgets to wire
// the fake fails loudly instead of editing the developer's crontab or LaunchAgents.
// ---------------------------------------------------------------------------------------------------------------
const SCHED_TIMEOUT_MS = 15000;

// The real ctx.sched. uid is the launchd domain (gui/<uid>); null where the platform has none, which only the
// darwin path reads.
//
// Test guard (2026-09-30 incident: a test spawned the entry script before its stubs were on PATH, and a real launchd
// job was bootstrapped into the developer's session). tests/tmp-guard.mjs sets AVGKEEPER_TEST_GUARD=1 in every test
// process and children inherit it. While it is set, a bare `crontab` or `launchctl` is never looked up on PATH: the
// binaries run only from the absolute directory named by AVGKEEPER_SCHED_BIN_DIR, and with no such directory every
// call returns a failure result without spawning anything.
const GUARD_REFUSAL = { code: 126, stdout: '', stderr: 'a test tried to reach the real scheduler (AVGKEEPER_TEST_GUARD is set and AVGKEEPER_SCHED_BIN_DIR names no absolute stub directory)\n' };

export function schedBinary(name, env = process.env) {
  if (env.AVGKEEPER_TEST_GUARD !== '1') return name;
  const dir = env.AVGKEEPER_SCHED_BIN_DIR;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  return path.join(dir, name);
}

function runSched(name, args, opts) {
  const file = schedBinary(name);
  if (file === null) return Promise.resolve({ ...GUARD_REFUSAL });
  return runChild(file, args, opts);
}

// The same guard for files. Under the marker, realSched's writeFile and removeFile refuse any path under the real user's
// home directory (from the account database, os.userInfo(), never $HOME: a test may point HOME at a temp folder, and
// that is exactly the folder it is allowed to use). A refusal is a thrown Error that install and stop already turn into
// a FAIL line, and nothing on disk is touched. Reading is not refused: it changes nothing.
const nearestRealPath = (p) => {
  let rest = '';
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), rest);
    } catch {
      if (path.dirname(cur) === cur) return path.resolve(p);
      rest = path.join(path.basename(cur), rest);
    }
  }
};
const inside = (dir, p) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
export function fileRefusal(p, env = process.env) {
  if (env.AVGKEEPER_TEST_GUARD !== '1') return null;
  let home = null;
  try { home = os.userInfo().homedir; } catch { /* treated as unknown below */ }
  // Home unknown means nothing can be proven safe, so nothing under the guard is allowed.
  if (!home) return `a test tried to change ${p}, and the real home directory could not be determined (AVGKEEPER_TEST_GUARD is set)`;
  let homeReal = home;
  try { homeReal = fs.realpathSync(home); } catch { /* the plain path still counts */ }
  const target = nearestRealPath(p);
  if ([home, homeReal].some((h) => inside(h, path.resolve(p)) || inside(h, target))) {
    return `a test tried to change ${p}, which is under the real home directory (AVGKEEPER_TEST_GUARD is set)`;
  }
  return null;
}

export function realSched() {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    crontabRead: () => runSched('crontab', ['-l'], { timeoutMs: SCHED_TIMEOUT_MS }),
    crontabWrite: (input) => runSched('crontab', ['-'], { input, timeoutMs: SCHED_TIMEOUT_MS }),
    launchctl: (args) => runSched('launchctl', args, { timeoutMs: SCHED_TIMEOUT_MS }),
    writeFile: (p, content) => {
      const refusal = fileRefusal(p);
      if (refusal) throw new Error(refusal);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    removeFile: (p) => {
      const refusal = fileRefusal(p);
      if (refusal) throw new Error(refusal);
      try {
        fs.unlinkSync(p);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    },
  };
}

function schedOf(ctx) {
  if (!ctx.sched) throw new Error('internal: ctx.sched is not wired, so the schedule cannot be installed, read or removed');
  return ctx.sched;
}

// "every hour at :05" or "every day at 10:00": a daily-clock plan fires every day and buys only on its buy days.
export function scheduleWhen(plan) {
  const cadence = parseCadence(plan.cadence);
  return cadence && cadence.kind === 'hour' ? `every hour at ${plan.at}` : `every day at ${plan.at}`;
}

// The one sentence the receipt and doctor both use for what the installed entry does (rule 3, one fact one reader):
// the entry wakes AvgKeeper on its clock, and a plan with a longer cadence buys only on its own buy days. A plain
// daily plan buys every time it wakes, so it gets no such clause.
export function scheduleWakes(plan) {
  const cadence = parseCadence(plan.cadence);
  const everyWake = cadence && (cadence.kind === 'hour' || cadence.kind === 'day');
  return `AvgKeeper wakes ${scheduleWhen(plan)} machine time${everyWake ? '' : " and buys only on the plan's buy days"}`;
}
// The scheduler named in words a non-technical user can follow, the one phrase for receipt and doctor.
export const viaPhrase = (via) => (via === 'launchd' ? "launchd, macOS's own scheduler" : 'crontab, the system scheduler');

export const cronMarker = (o) => `# avgkeeper ${o.profile} ${o.demo ? 'demo' : 'live'} (do not edit; AvgKeeper manages this line)`;
const MARKER_PREFIX = /^# avgkeeper (\S+) (live|demo) \(do not edit; AvgKeeper manages this line\)$/;

// A crontab line that runs `avgkeeper.mjs buy` for exactly this profile and mode, marked or pasted by hand.
function isBuyEntryFor(line, o) {
  if (line.trimStart().startsWith('#')) return false;
  // The script's basename must be exactly avgkeeper.mjs: start of line, a space, a quote or a slash before it, so
  // /x/myavgkeeper.mjs is another program's and never ours to touch.
  const m = /(?:^|[\s'"/])avgkeeper\.mjs['"]?\s+buy(\s.*)?$/.exec(line);
  if (!m) return false;
  const words = (m[1] || '').split(/\s+/).filter(Boolean);
  const at = words.indexOf('--profile');
  if (at < 0 || words[at + 1] !== o.profile) return false;
  return words.includes('--demo') === Boolean(o.demo);
}

// Pure: the crontab text with every AvgKeeper entry for this profile and mode taken out, every other line kept byte
// for byte. Only AvgKeeper's own marker line for this profile and mode goes with the entry under it; any other comment,
// including a hand-written `# AvgKeeper` one above a pasted entry, is the user's and stays. removed counts the entries taken out.
export function withoutEntries(text, o) {
  const src = String(text).split('\n');
  if (src[src.length - 1] === '') src.pop();
  const out = [];
  let removed = 0;
  for (let i = 0; i < src.length; i += 1) {
    const line = src[i];
    const marker = MARKER_PREFIX.exec(line);
    if (marker && marker[1] === o.profile && (marker[2] === 'demo') === Boolean(o.demo)) {
      removed += 1;
      if (i + 1 < src.length && isBuyEntryFor(src[i + 1], o)) i += 1;
      continue;
    }
    if (isBuyEntryFor(line, o)) {
      removed += 1;
      continue;
    }
    out.push(line);
  }
  return { lines: out, removed };
}

const NO_CRONTAB = /no crontab/i;
const UNSAFE_CRONTAB = 'your crontab contains characters AvgKeeper cannot read back safely, so it did not change it';
const why = (r) => (r.timedOut ? 'it did not finish in time' : lastLine(r));

// The user's crontab as text, '' when there is none, or { error } when it cannot be read. Never guesses: an unreadable
// crontab is never treated as empty, because writing back from that would erase the user's own lines.
async function readCrontab(sched) {
  const r = await sched.crontabRead();
  if (r.code === 0) {
    const text = String(r.stdout || '');
    // runChild decodes as UTF-8, and bytes that are not valid UTF-8 (a Latin-1 comment) come back as U+FFFD. Writing
    // that text back would replace the user's own bytes with the replacement character, so it is unreadable.
    if (text.includes(String.fromCharCode(0xFFFD))) return { error: UNSAFE_CRONTAB };
    return { text };
  }
  if (r.code === 1 && NO_CRONTAB.test(`${r.stderr || ''}${r.stdout || ''}`)) return { text: '' };
  return { error: `crontab -l exited ${r.code === null ? 'without a code' : r.code}: ${why(r)}` };
}

async function writeCrontab(sched, lines) {
  const body = lines.length ? `${lines.join('\n')}\n` : '';
  const r = await sched.crontabWrite(body);
  if (r.code !== 0) return { error: `crontab write exited ${r.code === null ? 'without a code' : r.code}: ${why(r)}` };
  return {};
}

// Drops this profile and mode's crontab entries (keeping everything else) and returns how many were removed.
async function dropCrontabEntries(sched, o) {
  const read = await readCrontab(sched);
  if (read.error) return { readError: read.error };
  const { lines, removed } = withoutEntries(read.text, o);
  if (!removed) return { removed: 0 };
  const w = await writeCrontab(sched, lines);
  return w.error ? { error: w.error } : { removed };
}

// What `launchctl print gui/<uid>/<label>` said: 'loaded' (exit 0), 'notloaded' (launchd says it has no such service:
// exit 113 or "Could not find service"), or 'unknown' for everything else (a timeout, exit 126, any other code). Only
// the first two are facts; unknown is never read as either (rule 2, never state a cause the code did not check).
export function printClass(r) {
  if (r.timedOut) return 'unknown';
  if (r.code === 0) return 'loaded';
  if (r.code === 113 || /could not find service/i.test(String(r.stderr || ''))) return 'notloaded';
  return 'unknown';
}
const printWhy = (r) => `launchctl print exited ${r.code === null ? 'without a code' : r.code}: ${why(r)}`;

// After a failed macOS install: boot the job out (errors ignored, the job may never have loaded), delete the plist so
// nothing loads at next login, then look instead of assuming. Returns null when the plist is gone and launchd
// confirms no such job, else where an entry may be left.
async function cleanupLaunchd(sched, l, domain) {
  try { await sched.launchctl(['bootout', `${domain}/${l.label}`]); } catch { /* the checks below decide */ }
  try { sched.removeFile(l.plistPath); } catch { /* the checks below decide */ }
  let fileLeft;
  try { fileLeft = sched.readFile(l.plistPath) !== null; } catch { fileLeft = true; }
  let loaded;
  try { loaded = printClass(await sched.launchctl(['print', `${domain}/${l.label}`])); } catch { loaded = 'unknown'; }
  return fileLeft || loaded !== 'notloaded' ? `launchd (plist ${l.plistPath}, job ${l.label})` : null;
}

// Installs this plan's schedule entry. Returns { ok: true, via, when, wakes, logPath, warnings, risks } or { ok: false, reason, left, mayRemain, warnings }.
// mayRemain is set when the failure came before anything of an earlier entry was touched and the code either saw that
// entry (a matching crontab line) or could not look: an earlier AvgKeeper entry may still run this plan.
// left is set only when the install failed AND taking its own partial work back failed too: where an entry may still
// be. Never throws for an install problem: the plan is already on by the time this runs, and a failed install never
// un-confirms it. A failed install leaves nothing behind that loads at next login or fires on its own.
export async function installSchedule(ctx, o, plan) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const platform = ctx.platform || process.platform;
  const env = ctx.env || {};
  try {
    const sched = schedOf(ctx);
    const when = scheduleWhen(plan);
    if (platform === 'darwin') {
      const l = launchdConfig(env, call, plan, ctx.realHome);
      if (l.why) return { ok: false, reason: l.why };
      const domain = `gui/${sched.uid}`;
      const warnings = [];
      // A crontab line AvgKeeper wrote (or a user pasted) for this same profile and mode would fire next to the
      // launchd job: two schedulers running one plan (the period guard stops a second buy, but the entry still
      // fires). Taken out first. An unreadable crontab is not an error here (macOS may have none to read), but the
      // receipt says the check was not made; a removal that fails is an error, since both would keep running.
      const read = await readCrontab(sched);
      if (read.error) {
        warnings.push(`WARNING: AvgKeeper could not read your crontab (${read.error}), so it could not check it for an old AvgKeeper line. If one is there, delete it with crontab -e so two schedules do not fire.`);
      } else {
        const { lines, removed } = withoutEntries(read.text, call);
        if (removed) {
          const w = await writeCrontab(sched, lines);
          // The crontab line was seen and is still there: it is an earlier AvgKeeper entry that keeps running.
          if (w.error) return { ok: false, reason: `an AvgKeeper crontab entry for this profile would run next to launchd, and it could not be removed (${w.error})`, mayRemain: true, warnings };
        }
      }
      const fail = async (reason) => {
        const left = await cleanupLaunchd(sched, l, domain);
        if (left) return { ok: false, reason, left, warnings };
        // A crontab the code could not read may hold an earlier AvgKeeper line; it never looked, so it cannot say none.
        return read.error ? { ok: false, reason, mayRemain: true, warnings } : { ok: false, reason, warnings };
      };
      try {
        sched.writeFile(l.plistPath, `${l.plist}\n`);
      } catch (e) {
        return fail(String(e && e.message ? e.message : e));
      }
      // Not loaded yet is the ordinary first-install case, so a failed bootout is ignored; a real problem shows at bootstrap.
      await sched.launchctl(['bootout', `${domain}/${l.label}`]);
      const boot = await sched.launchctl(['bootstrap', domain, l.plistPath]);
      if (boot.code !== 0) return fail(`launchctl bootstrap exited ${boot.code === null ? 'without a code' : boot.code}: ${why(boot)}`);
      const back = await readScheduleState(ctx, call, plan);
      if (back.state !== 'installed' || back.via !== 'launchd') return fail(`launchd did not show the job after loading it (${back.detail || back.state})`);
      return {
        ok: true, via: 'launchd', when, wakes: scheduleWakes(plan), logPath: l.logPath, warnings, risks: scheduleRisks(l, { platform, realHome: ctx.realHome }),
      };
    }
    const cron = buySchedule(env, call, plan);
    if (cron.why) return { ok: false, reason: cron.why };
    const read = await readCrontab(sched);
    // Could not look: an earlier entry may be there.
    if (read.error) return { ok: false, reason: read.error, mayRemain: true };
    const { lines, removed: seen } = withoutEntries(read.text, call);
    const w = await writeCrontab(sched, [...lines, cronMarker(call), cron.line]);
    // The write failed, so the crontab is as it was: an entry remains only if one was seen in it.
    if (w.error) return seen ? { ok: false, reason: w.error, mayRemain: true } : { ok: false, reason: w.error };
    const back = await readScheduleState(ctx, call, plan);
    if (back.state !== 'installed') {
      // The write succeeded but the crontab does not show the entry: put the crontab back without ours, so nothing
      // half-installed stays. If even that fails, say where an entry may be.
      const reason = `the crontab did not show the entry after writing it (${back.detail || back.state})`;
      const undo = await writeCrontab(sched, lines);
      return undo.error ? { ok: false, reason, left: 'your crontab' } : { ok: false, reason };
    }
    return {
      ok: true, via: 'crontab', when, wakes: scheduleWakes(plan), logPath: cron.logPath, warnings: [], risks: scheduleRisks(cron, { platform, realHome: ctx.realHome }),
    };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

// What is installed right now for this profile and mode, read only. state: 'installed' (matches this plan),
// 'different' (an entry exists that differs from what doctor prints now), 'missing', or 'unknown' (could not be read
// or launchd gave an answer that is neither loaded nor not found). An installed answer also carries problems, the
// things that make it wrong even though it matches: a second AvgKeeper entry that would fire next to it.
export async function readScheduleState(ctx, call, plan) {
  const platform = ctx.platform || process.platform;
  const env = ctx.env || {};
  try {
    const sched = schedOf(ctx);
    if (platform === 'darwin') {
      const l = launchdConfig(env, call, plan, ctx.realHome);
      if (l.why) return { state: 'unknown', detail: l.why };
      // launchd has nothing for this plan. A crontab line for this profile and mode put there by hand (AVGPLAN never
      // writes one on macOS) still fires, so "missing" with advice to install another would be false: it is reported
      // the way a hand-added crontab line is on Linux. An unreadable crontab changes nothing here: missing stays missing.
      const launchdMissing = async (missing) => {
        const cron = await readCrontab(sched);
        if (cron.error || !withoutEntries(cron.text, call).removed) return missing;
        const byHandLine = buySchedule(env, call, plan);
        if (byHandLine.why) return missing;
        const src = cron.text.split('\n');
        if (!src.includes(byHandLine.line)) return { state: 'different', via: 'crontab' };
        return { state: 'installed', via: 'crontab', byHand: !src.includes(cronMarker(call)), problems: [] };
      };
      const saved = sched.readFile(l.plistPath);
      if (saved === null) return launchdMissing({ state: 'missing', via: 'launchd' });
      if (saved.trimEnd() !== l.plist.trimEnd()) return { state: 'different', via: 'launchd' };
      const p = await sched.launchctl(['print', `gui/${sched.uid}/${l.label}`]);
      const loaded = printClass(p);
      if (loaded === 'unknown') return { state: 'unknown', via: 'launchd', detail: `the plist is saved, but launchd could not say whether it is loaded (${printWhy(p)})` };
      if (loaded === 'notloaded') return launchdMissing({ state: 'missing', via: 'launchd', detail: 'the plist is saved but launchd has not loaded it' });
      // A crontab entry for the same profile and mode fires next to the launchd job. An unreadable crontab says nothing either way.
      const problems = [];
      const cron = await readCrontab(sched);
      if (!cron.error) {
        const extra = withoutEntries(cron.text, call).removed;
        if (extra) problems.push(`your crontab also holds ${extra === 1 ? 'an AvgKeeper buy line' : `${extra} AvgKeeper buy lines`} for this profile, so a second scheduler runs this plan next to launchd. Make the plan again with AVGPLAN, which takes ${extra === 1 ? 'it' : 'them'} out, or delete ${extra === 1 ? 'it' : 'them'} yourself with crontab -e (the "# avgkeeper" comment and the line under it).`);
      }
      return { state: 'installed', via: 'launchd', problems };
    }
    const cron = buySchedule(env, call, plan);
    if (cron.why) return { state: 'unknown', detail: cron.why };
    const read = await readCrontab(sched);
    if (read.error) return { state: 'unknown', detail: read.error };
    const src = read.text.split('\n');
    const entries = withoutEntries(read.text, call).removed;
    // The exact line of this plan reads as installed even with no marker above it (a line pasted by hand).
    if (src.includes(cron.line)) {
      const problems = entries > 1 ? [`your crontab holds ${entries} AvgKeeper buy lines for this profile, so the buy is scheduled ${entries} times. Make the plan again with AVGPLAN, which replaces them with one.`] : [];
      return {
        state: 'installed', via: 'crontab', byHand: !src.includes(cronMarker(call)), problems,
      };
    }
    if (entries) return { state: 'different', via: 'crontab' };
    return { state: 'missing', via: 'crontab' };
  } catch (e) {
    return { state: 'unknown', detail: String(e && e.message ? e.message : e) };
  }
}

// Whether any AvgKeeper entry for this profile and mode is installed, with no plan needed (doctor has none once a plan
// is stopped). Read only. state: 'found', 'none' or 'unknown'. 'none' only when every place checked answered: on
// macOS the plist file and launchd's own answer, everywhere the crontab. plistSaved: the macOS plist file exists.
export async function readEntryPresence(ctx, call) {
  const platform = ctx.platform || process.platform;
  try {
    const sched = schedOf(ctx);
    let found = false;
    let detail = null;
    let plistSaved = false;
    if (platform === 'darwin') {
      plistSaved = sched.readFile(launchdPlistPath(call, ctx.realHome)) !== null;
      const p = await sched.launchctl(['print', `gui/${sched.uid}/${launchdLabel(call)}`]);
      const loaded = printClass(p);
      if (plistSaved || loaded === 'loaded') found = true;
      else if (loaded === 'unknown') detail = printWhy(p);
    }
    const cron = await readCrontab(sched);
    if (cron.error) detail = detail || cron.error;
    else if (withoutEntries(cron.text, call).removed) found = true;
    if (found) return { state: 'found', plistSaved };
    return detail ? { state: 'unknown', detail, plistSaved } : { state: 'none', plistSaved };
  } catch (e) {
    return { state: 'unknown', detail: String(e && e.message ? e.message : e), plistSaved: false };
  }
}

// Takes this profile and mode's schedule entry out. Returns { ok: true, removed: <how many places> } or
// { ok: false, reason }. Only AvgKeeper's own entry for this profile and mode; every other crontab line stays.
export async function removeSchedule(ctx, o) {
  const call = { profile: o.profile, demo: Boolean(o.demo) };
  const platform = ctx.platform || process.platform;
  try {
    const sched = schedOf(ctx);
    let removed = 0;
    if (platform === 'darwin') {
      const plistPath = launchdPlistPath(call, ctx.realHome);
      const had = sched.readFile(plistPath) !== null;
      const domain = `gui/${sched.uid}`;
      const bootout = await sched.launchctl(['bootout', `${domain}/${launchdLabel(call)}`]);
      // A bootout that failed for any reason other than "not loaded" leaves the job running; asking launchd settles
      // it. Only "loaded" and "not found" are answers: a timeout or any other exit is unknown, and stop never says
      // the schedule is removed on a guess.
      const still = await sched.launchctl(['print', `${domain}/${launchdLabel(call)}`]);
      const loaded = printClass(still);
      if (loaded === 'loaded') return { ok: false, reason: `launchd still has the job loaded after bootout (${why(still)})` };
      if (loaded === 'unknown') return { ok: false, reason: `launchd could not say whether the job is still loaded after bootout (${printWhy(still)})` };
      if (had) sched.removeFile(plistPath);
      // A bootout that exited 0 took a loaded job out, which is a removal even when no plist file was on disk.
      if (had || bootout.code === 0) removed += 1;
      // A crontab entry is taken out too. An unreadable crontab is not "nothing there": an entry could be in it.
      const c = await dropCrontabEntries(sched, call);
      const done = removed ? 'the launchd job was taken out, but ' : '';
      if (c.readError) return { ok: false, reason: `${done}the crontab could not be read to look for an AvgKeeper line (${c.readError})` };
      if (c.error) return { ok: false, reason: `${done}${c.error}` };
      return { ok: true, removed: removed + (c.removed || 0) };
    }
    const c = await dropCrontabEntries(sched, call);
    if (c.readError) return { ok: false, reason: c.readError };
    if (c.error) return { ok: false, reason: c.error };
    return { ok: true, removed: c.removed };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}
