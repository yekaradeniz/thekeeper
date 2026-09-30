// avgkeeper/scripts/runlog.mjs
// Item 4 of the 2026-09-27 release audit: a scheduled run's own stdout and stderr went nowhere before this file
// existed, so a run that failed unattended left no trace anywhere AvgKeeper itself shows. schedule.mjs's cron line
// now ends with `>> <log> 2>&1` and its launchd plist sets StandardOutPath and StandardErrorPath to the same file,
// one file per profile and mode, named the way the buy lock already is (planview.mjs's buyLockName): one fact, one
// reader. This module only ever reads that file. It never writes it: the log itself is produced by the shell
// redirect or by launchd, never by AvgKeeper's own code, so a dry run or a smoke run (which never goes through
// either) never touches it either.
import fs from 'node:fs';
import path from 'node:path';
import { buyLockName } from './planview.mjs';
import { isoMinute } from './units.mjs';
import { localParts, hhmm } from './period.mjs';

export const LOG_TAIL_LINES = 20;

// The path a scheduled run's own output lands in, for this profile and mode, under `home` (the AvgKeeper store
// directory): ctx.store.home for the process reading it back, or the same value schedule.mjs computes for the
// line it prints for the user to install, from resolveAvgkeeperHome (store.mjs). One name, both directions.
export function logPathIn(home, call) {
  return path.join(home, `${buyLockName(call)}.log`);
}

// A crash that never reached AvgKeeper's own ctx.out (a Node exception thrown before avgkeeper.mjs's own
// try/catch, an interpreter fatal error, a killed process) prints a stack trace or an interpreter's own error line,
// never one of AvgKeeper's own sentences (every one of which is a plain, capitalized English sentence with no
// stack frame and no "SomethingError:" prefix). This is a heuristic over common Node and shell crash shapes, not a
// parse of AvgKeeper's own output, and it never claims to explain what happened: only that the log's last line
// does not read like an ordinary finish.
// Finding 15 of the 2026-09-27 release-readiness review, checked against real output: an uncaught exception ends in
// Node's own "Node.js vX.Y.Z" trailer, and a scheduled node path that is gone ends in the shell's own line, "/bin/sh:
// <path>: No such file or directory" (macOS) or "/bin/sh: 1: <path>: not found" (dash). The old Error pattern also
// needed a letter before "Error", so a plain "Error: ..." never matched.
export function looksLikeCrashLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (/^at\s.+:\d+:\d+\)?$/.test(t)) return true; // a stack frame, "at foo (file:1:1)"
  if (/^([A-Za-z][A-Za-z0-9]*)?Error(:|\s|\[|$)/.test(t)) return true; // Error:, TypeError:, Error [ERR_...]
  if (/^Node\.js v\d+\.\d+\.\d+$/.test(t)) return true; // Node's trailer after an uncaught exception
  if (/^(FATAL ERROR|Segmentation fault|Aborted|Illegal instruction|Bus error)\b/i.test(t)) return true;
  if (/: (command not found|not found|No such file or directory|Permission denied)$/.test(t)) return true;
  if (/^internal\/|^node:internal/.test(t)) return true;
  return false;
}

// The log's last lines, and whether the very last non-empty one looks like a crash. null when the file does not
// exist yet (no scheduled run has ever reached it) or cannot be read: a missing log is not itself a problem to
// name, since a fresh install has none yet.
// Review finding (runlog.mjs:63, later): the log carries no time or run marker on any line (the cron redirect and
// launchd both only ever append the run's own plain output), so the WARNING below could not say when a crash
// happened, or which run printed it, and kept showing an already-fixed crash as current until the next scheduled
// run wrote a fresh, ordinary finish over it, up to a day away for a daily plan. mtimeMs is the file's own last-
// write time, the one fact this module can read without this file ever writing to the log itself.
export function readLogTail(home, call, n = LOG_TAIL_LINES) {
  const file = logPathIn(home, call);
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { path: file, lines: [], crash: false, mtimeMs };
  return { path: file, lines: lines.slice(-n), crash: looksLikeCrashLine(lines[lines.length - 1]), mtimeMs };
}

// status and doctor's one reader (rule 3, one fact one reader): the lines to print about the scheduled run's own
// log, or [] when there is nothing worth showing (no log yet, or its last line reads like an ordinary finish).
// Never states a cause, only shows the tail itself and lets the user read it.
// timeZone: the plan's own (status and doctor both already have one in hand, having just called lastRunLine).
// Review finding (schedule.mjs:75 area, later): a bare UTC ISO stamp here read alongside "Last run" and "Started"
// in the plan's own local time, with its zone named, could look three hours apart for the exact same instant.
// Read the same way lastRunLine already does (localParts and hhmm, period.mjs); falls back to UTC ISO only for a
// caller with no time zone in hand at all.
export function logStatusLines(home, call, timeZone) {
  const tail = readLogTail(home, call);
  if (!tail || !tail.crash) return [];
  let when = isoMinute(tail.mtimeMs);
  if (timeZone) {
    const local = localParts(tail.mtimeMs, timeZone);
    when = `${local.date} ${hhmm(local.minutes)} (${timeZone})`;
  }
  return [
    `WARNING: the scheduled run's own log (${tail.path}) ends with a line that does not read like an ordinary finish, last written ${when}. Last ${tail.lines.length} line${tail.lines.length === 1 ? '' : 's'}:`,
    ...tail.lines.map((l) => `  ${l}`),
  ];
}
