// avgkeeper/scripts/notify.mjs
// The user's own notify command (config.json key notify, written by the user) and the level that decides which
// lines reach it. runNotify and readConfigSafe are GridKeeper's (gridkeeper.mjs, verbs.mjs).
//
// tell() (bottom of this file) is the one call buy.mjs makes instead of notify(): it sends the one-line notify
// message exactly as before, then hands the same line to mail.mjs's prepareMail so a call site can never do one
// and forget the other (spec section 9). notify.mjs imports prepareMail from mail.mjs, and mail.mjs imports
// readConfigSafe, NOTIFY_LEVELS, shouldNotify, runShellPiped and NOTIFY_TIMEOUT_MS back from here; both sides use
// the other's export only inside a function body, never at module-top-level, so the cycle never reads a binding
// before its module has initialized it.
import { spawn } from 'node:child_process';
import { OKX_KEY_ENV } from './runner.mjs';
import { prepareMail, mailReachLine } from './mail.mjs';

export const NOTIFY_LEVELS = ['off', 'problems', 'all'];
export const NOTIFY_TIMEOUT_MS = 10000;
export const levelOf = (config) => (NOTIFY_LEVELS.includes(config && config.notifyLevel) ? config.notifyLevel : 'problems');
// severity 'problem': a skip, a rejection, a halt. 'info': a finished buy, or a period with no coin in loss.
export const shouldNotify = (level, severity) => level === 'all' || (level === 'problems' && severity === 'problem');
// What each level lets through, worded from shouldNotify and the severity every buy.mjs call site passes: 'info' is
// a buy that went through with no problem, a later read-back where every order filled, and a period with no coin in
// loss; everything else buy reports is 'problem'. One reader for the notify and the mail screens (rule 3).
export const LEVEL_WORDS = {
  off: 'Nothing is sent.',
  problems: 'Only problems are sent: for example a skipped period, a rejected order, an order whose result is not known yet, a halt, a time zone change, a stale lock or a damaged ledger. A period skipped because no coin is in loss is not a problem.',
  all: 'Every problem is sent, and also every buy that went through, every later read-back that filled, and every period with no coin in loss.',
};

// doctor's own "Notify: ..." line (ProjectBuilder rule 3, one fact one reader). Review findings (schedule.mjs:244):
// with no notify command set, "nothing reaches you" was false whenever mail was on; the sentence now names both
// facts. A command set with level off is off, the same word mailLine uses for the same state, not "on, level off."
//
// Review finding (notify.mjs:36, should): the mail clause here still said mail "reaches" the user whenever it was
// on, even with no mail.command set, so it named delivery mail did not in fact have on its own; mailReachLine
// already tells notify's own line and smoke apart on that exact point (6dedffa). Built from it here too (rule 4,
// a fact one surface knows, every surface knows), so doctor never disagrees with them.
export function notifyStatusLine(config) {
  if (!config.notify) {
    const reach = mailReachLine(config);
    return reach ? `Notify: no command set. ${reach}. It also shows in status.` : 'Notify: no command set, so nothing reaches you when a buy is skipped or halted.';
  }
  const level = levelOf(config);
  if (level === 'off') return 'Notify: off (a command is set, level off).';
  return `Notify: on, level ${level}.`;
}

const held = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  const t = typeof v;
  return t === 'object' ? 'an object' : `a ${t}`;
};

// Review finding (notify.mjs:59, should): config.json breaking a different way breaks a different amount of it.
// Invalid JSON or the wrong shape entirely loses every key, mail's own to/level/command included, so both
// channels go dark; the line named only notify. A bad notify key alone keeps every other key (the returned config
// below still carries mail unchanged), so mail's own settings keep working once the refusal clears, but nothing
// can be changed about mail meanwhile either (mailVerb refuses on this same line): named as its own, narrower
// effect, never the wider "both are off" sentence that only fits the first case.
export function readConfigSafe(store) {
  let config;
  try {
    config = store.readConfig();
  } catch (e) {
    return { config: {}, line: `config.json is not valid JSON (${String(e.message).split('\n')[0]}); notify and mail are both off until it is fixed.` };
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { config: {}, line: `config.json must hold a JSON object ({ ... }); it holds ${held(config)}. Notify and mail are both off until it is fixed.` };
  }
  if (config.notify !== undefined && !(typeof config.notify === 'string' && config.notify.trim())) {
    return { config: { ...config, notify: undefined }, line: `config.json key notify must be a command in quotes; it holds ${held(config.notify)}. Notify is off, and mail cannot be changed, until it is fixed.` };
  }
  return { config, line: null };
}

// The child-process contract every command AvgKeeper hands the user's own shell shares: detached, so a shell
// wrapper's own children (`sh -c "a | b"`) do not outlive it; its own process group killed on timeout, not just
// the immediate child; OKX's own key variables stripped from its environment, since the command reaches the
// user's own notifier or mailer, never OKX. `label` names the command in a timeout or a non-zero-exit message
// only; runNotify and mail.mjs's runMail share this one implementation rather than each spawning their own.
export function runShellPiped(cmd, stdin, { timeoutMs = NOTIFY_TIMEOUT_MS, label = 'command', extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    for (const k of OKX_KEY_ENV) delete env[k];
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'pipe'], env, detached: true });
    let err = '';
    const killTree = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      killTree();
      child.stderr.destroy();
      child.unref();
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}: ${err.trim().split('\n')[0]}`.trim()));
    });
    child.stdin.end(stdin);
  });
}

export function runNotify(cmd, line, timeoutMs = NOTIFY_TIMEOUT_MS) {
  return runShellPiped(cmd, line + '\n', { timeoutMs, label: 'notify command' });
}

// Sends one line when the level allows it. Never throws: a notify failure never changes a buy or its exit code.
export async function notify(ctx, severity, line) {
  const { config, line: bad } = readConfigSafe(ctx.store);
  if (bad) {
    ctx.out(`WARNING: ${bad}`);
    return;
  }
  if (!config.notify || !shouldNotify(levelOf(config), severity)) return;
  try {
    await ctx.runNotify(config.notify, line);
  } catch (e) {
    ctx.out(`WARNING: your notify command failed: ${e.message}`);
  }
}

// tell(): buy.mjs's one call for both the notify line and a mail notice, so a call site can never remember one and
// forget the other (spec section 9). extra is prepareMail's own { kind, planId, period, planLine }; see mail.mjs.
export async function tell(ctx, call, severity, line, extra = {}) {
  await notify(ctx, severity, line);
  await prepareMail(ctx, call, severity, line, extra);
}
