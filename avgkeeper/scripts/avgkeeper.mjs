#!/usr/bin/env node
// avgkeeper/scripts/avgkeeper.mjs
// Entry: parses argv, checks every flag against the verb, builds the context and runs the verb. Exit codes: 0 done,
// 1 refused or failed.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { createRunner } from './runner.mjs';
import { createStore, homeDir } from './store.mjs';
import { PROFILE_NAME, failureLine } from './guards.mjs';
import { runNotify } from './notify.mjs';
import { mailVerb, runMail } from './mail.mjs';
import { planVerb } from './plan.mjs';
import { buyVerb } from './buy.mjs';
import {
  holdingsVerb, statusVerb, stopVerb, notifyVerb,
} from './manage.mjs';
import { doctorVerb, smokeVerb, runChild } from './schedule.mjs';

const BOOL_FLAGS = new Set(['demo', 'dry-run', 'smoke', 'launchd', 'pending']);

// --launchd only picks the form smoke tests; on a real buy it would be silently ignored, so it is refused.
function buyOrSmoke(ctx, o) {
  if (o.smoke) return smokeVerb(ctx, o);
  if (o.launchd) {
    ctx.out('REFUSED: --launchd goes with --smoke only.');
    return 1;
  }
  return buyVerb(ctx, o);
}
export const VERBS = {
  holdings: { run: holdingsVerb, flags: ['profile', 'demo', 'dust'] },
  plan: { run: planVerb, flags: ['profile', 'demo', 'budget', 'every', 'at', 'method', 'only', 'exclude', 'dust', 'confirm'] },
  buy: { run: buyOrSmoke, flags: ['profile', 'demo', 'dry-run', 'smoke', 'launchd'] },
  doctor: { run: doctorVerb, flags: ['profile', 'demo'] },
  status: { run: statusVerb, flags: ['profile', 'demo'] },
  stop: { run: stopVerb, flags: ['profile', 'demo'] },
  notify: { run: notifyVerb, flags: ['level'], noProfile: true },
  // mail's address, level and whether a command is set are one account-wide setting in config.json, the same as
  // notify, so --profile is not required. Its pending notices are still per profile and mode (spec section 9: a
  // notice carries the profile and env it was prepared for), so --profile and --demo stay allowed, to filter
  // --pending and the count on the plain screen, and to fill in --sent's own confirmation line; they default to
  // no profile and live, the same default every other optional-profile screen in this file uses.
  mail: {
    run: mailVerb, flags: ['to', 'level', 'pending', 'sent', 'profile', 'demo'], noProfile: true,
  },
};

export const USAGE = [
  'AvgKeeper: buys your losing OKX spot coins on a schedule.',
  '  holdings --profile <p> [--demo]',
  '  plan --profile <p> --budget <usdt> --every hour|day|days:<n>|week:<mon..sun>|month:<1-31> --method equal|weighted [--at HH:MM, or :MM with --every hour] [--only A,B | --exclude A,B] [--dust <usdt>] [--demo] [--confirm AVGPLAN]',
  '  status --profile <p> [--demo]',
  '  stop --profile <p> [--demo]',
  '  notify [--level off|problems|all]',
  '  mail [--profile <p>] [--demo]   (address, level, whether a command is set, and the pending count)',
  '  mail --to <address> [--profile <p>] [--demo]',
  '  mail --level off|problems|all [--profile <p>] [--demo]',
  '  mail --pending [--profile <p>] [--demo]',
  '  mail --sent <id> [--profile <p>] [--demo]',
  '  doctor --profile <p> [--demo]   (prints the schedule line for you to install)',
  '  buy --smoke [--launchd] --profile <p> [--demo]   (proves the line doctor prints runs; it does not check that it is installed)',
  '  buy --profile <p> [--demo] [--dry-run]   (your schedule runs this)',
].join('\n');

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const o = { verb };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`REFUSED: ${a} is not a flag. Flags start with --.`);
    const k = a.slice(2);
    // A second value would silently replace the first (and --verb would replace the verb itself).
    if (Object.prototype.hasOwnProperty.call(o, k)) throw new Error(`REFUSED: --${k} was given twice.`);
    if (BOOL_FLAGS.has(k)) {
      o[k] = true;
      continue;
    }
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`REFUSED: --${k} needs a value.`);
    o[k] = v;
    i += 1;
  }
  return o;
}

// Item 10 of the 2026-09-27 release audit: AvgKeeper's own schedule (schedule.mjs) prints a crontab line and a
// launchd plist, neither of which native Windows has; nothing here has ever been run or tested against it. Checked
// before argv is even parsed, so every verb refuses the same way, in one sentence, rather than failing later with
// a path or shell error that reads as a bug. WSL reports 'linux', not 'win32', so it is unaffected.
export function refuseWindows(ctx) {
  const platform = (ctx && ctx.platform) || process.platform;
  if (platform !== 'win32') return null;
  return 'REFUSED: AvgKeeper runs on macOS or Linux only; native Windows is not supported.';
}

export async function main(argv, ctx) {
  const windows = refuseWindows(ctx);
  if (windows) {
    ctx.out(windows);
    return 1;
  }
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    ctx.out(e.message);
    return 1;
  }
  const spec = VERBS[o.verb];
  if (!spec) {
    ctx.out(o.verb ? `Unknown verb ${o.verb}.` : 'No verb given.');
    ctx.out(USAGE);
    return 1;
  }
  for (const k of Object.keys(o)) {
    if (k !== 'verb' && !spec.flags.includes(k)) {
      ctx.out(`REFUSED: ${o.verb} does not take --${k}.`);
      return 1;
    }
  }
  if (!spec.noProfile) {
    if (o.profile === undefined) {
      ctx.out('REFUSED: pass --profile <p>, the okx profile to use.');
      return 1;
    }
    if (!PROFILE_NAME.test(o.profile)) {
      ctx.out('REFUSED: a profile name is letters, digits, dot, dash or underscore.');
      return 1;
    }
  }
  try {
    return await spec.run(ctx, o);
  } catch (e) {
    ctx.out(failureLine(e, o.profile));
    return 1;
  }
}

export function makeCtx(env = process.env) {
  return {
    okx: createRunner({ env }),
    store: createStore(homeDir(env)),
    env,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: process.platform,
    realHome: os.homedir(),
    now: () => Date.now(),
    out: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    runNotify,
    runMail,
    runChild,
  };
}

// Compared through realpath: a skill folder reached through a symlink (macOS's /var is /private/var, and a skill
// can be linked into an agent's skills folder) otherwise never matches, so every verb, the scheduled buy included,
// exited 0 having done nothing (found 2026-09-27 by tests/independence.test.mjs; GridKeeper's entry already did this).
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main(process.argv.slice(2), makeCtx()).then((code) => { process.exitCode = code; });
