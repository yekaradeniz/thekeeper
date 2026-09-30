// avgkeeper/scripts/cmdtext.mjs
// There is no `avgkeeper` command on PATH: it is a name this skill's own text uses for itself, never something a
// shell can run (ProjectBuilder rule: every command a user types runs exactly as printed and names the full path).
// commandText is the one reader every printed instruction goes through instead of writing the bare word
// "avgkeeper": `<node> <ENTRY_SCRIPT> <args>`, both paths quoted for the shell by shWord.
//
// A leaf module on purpose: it imports nothing from schedule.mjs, mail.mjs or manage.mjs, so all three (schedule.mjs
// already imports mail.mjs for its own printed lines) can import commandText from here with no import cycle.
// schedule.mjs re-exports ENTRY_SCRIPT, shWord, cronWord and stableNode from here, unchanged, for the tests and
// modules that already import them from schedule.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENTRY_SCRIPT = fileURLToPath(new URL('./avgkeeper.mjs', import.meta.url));

export const shWord = (s) => (/^[\w/.:@+,=-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
export const cronWord = (s) => shWord(s).replace(/%/g, '\\%');

// A node path that survives a Homebrew or nvm upgrade: the first PATH entry whose node resolves to this one.
export function stableNode(env = {}, exec = process.execPath) {
  let real;
  try {
    real = fs.realpathSync(exec);
  } catch {
    return exec;
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.resolve(dir, 'node');
    try {
      if (fs.realpathSync(p) === real) return p;
    } catch {
      // no node in this folder
    }
  }
  return exec;
}

// The command a user can actually type right now, in their own shell, in place of the bare word "avgkeeper": this
// node (the same resolution doctor's cron line uses, here read from this process's own environment) plus the entry
// script plus the given words. `args` is already the finished tail (verb and flags, space separated), so args
// itself is not passed through shWord: the caller quotes each value that needs it. Profile names are restricted to
// characters shWord never has to quote. Notice ids are not: an hourly period is 'YYYY-MM-DD HH' (section 10), so
// an hourly notice id holds a space, and mail.mjs passes every id through shWord before it reaches args.
export function commandText(args) {
  return `${shWord(stableNode(process.env))} ${shWord(ENTRY_SCRIPT)} ${args}`;
}
