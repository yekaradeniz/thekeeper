// avgkeeper/tests/runlog.test.mjs
// Item 4 of the 2026-09-27 release audit: a scheduled run's own stdout and stderr went nowhere before this module
// existed. It only ever reads the log file schedule.mjs's cron redirect and launchd plist write to; it never
// writes one itself.
import { tmpDir, TZ } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  logPathIn, looksLikeCrashLine, readLogTail, logStatusLines, LOG_TAIL_LINES,
} from '../scripts/runlog.mjs';

const CALL = { profile: 't', demo: false };

test('logPathIn names the same file the buy lock already names, with a .log extension', () => {
  const home = tmpDir('ak-store-');
  assert.equal(logPathIn(home, CALL), `${home}/buy-t-live.log`);
  assert.equal(logPathIn(home, { profile: 't', demo: true }), `${home}/buy-t-demo.log`);
});

test('looksLikeCrashLine reads common Node and shell crash shapes, never an ordinary AvgKeeper finish', () => {
  assert.equal(looksLikeCrashLine('AvgKeeper bought 2026-10-05: ETH 5.00 USDT.'), false);
  assert.equal(looksLikeCrashLine('Nothing to buy now: today is not a buy day.'), false);
  assert.equal(looksLikeCrashLine('AvgKeeper HALTED: something. Nothing more is bought until you make a new plan.'), false);
  assert.equal(looksLikeCrashLine(''), false);
  assert.equal(looksLikeCrashLine('   '), false);
  assert.equal(looksLikeCrashLine('TypeError: Cannot read properties of undefined'), true);
  assert.equal(looksLikeCrashLine('ReferenceError: x is not defined'), true);
  assert.equal(looksLikeCrashLine('    at Object.<anonymous> (/x/avgkeeper.mjs:10:5)'), true);
  assert.equal(looksLikeCrashLine('okx: command not found'), true);
  assert.equal(looksLikeCrashLine('Segmentation fault: 11'), true);
});

// Finding 15 of the 2026-09-27 release-readiness review: the synthetic lines above missed the two most common real
// last lines, Node's own "Node.js vX.Y.Z" trailer after an uncaught exception, and the shell's line when the
// scheduled node path is gone (after the node upgrade doctor's own scheduleRisks warns about). These come from real
// spawned crashes, written to the log the way the cron redirect writes them.
function logOfRealRun(file, args) {
  const home = tmpDir('ak-store-');
  const r = spawnSync(file, args, { encoding: 'utf8' });
  fs.writeFileSync(logPathIn(home, CALL), `AvgKeeper bought 2026-10-05: ETH 5.00 USDT.\n${r.stdout}${r.stderr}`);
  return readLogTail(home, CALL);
}
test('a real Node crash and a real missing or unrunnable interpreter each read as a crash', () => {
  const gone = path.join(tmpDir('ak-crash-'), 'missing');
  const node = logOfRealRun(process.execPath, [path.join(gone, 'avgkeeper.mjs')]);
  assert.match(node.lines.at(-1), /^Node\.js v\d+\.\d+\.\d+$/, node.lines.join('\n'));
  assert.equal(node.crash, true, node.lines.join('\n'));
  const sh = logOfRealRun('/bin/sh', ['-c', `${path.join(gone, 'node')} x`]);
  assert.match(sh.lines.at(-1), /No such file or directory$|: not found$/, sh.lines.join('\n'));
  assert.equal(sh.crash, true, sh.lines.join('\n'));
  const notExecutable = path.join(tmpDir('ak-crash-'), 'node');
  fs.writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
  const denied = logOfRealRun('/bin/sh', ['-c', `${notExecutable} x`]);
  assert.match(denied.lines.at(-1), /Permission denied$/, denied.lines.join('\n'));
  assert.equal(denied.crash, true, denied.lines.join('\n'));
});

test('looksLikeCrashLine reads dash\'s missing-program line, a Node error code line and a plain Error: line', () => {
  assert.equal(looksLikeCrashLine('/bin/sh: 1: /usr/local/bin/node: not found'), true);
  assert.equal(looksLikeCrashLine("Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x/avgkeeper.mjs'"), true);
  assert.equal(looksLikeCrashLine('Error: Cannot find module'), true);
  assert.equal(looksLikeCrashLine('Errors are named in status.'), false);
});

test('readLogTail answers null with no log file yet, and reads it back once one exists', () => {
  const home = tmpDir('ak-store-');
  fs.mkdirSync(home, { recursive: true });
  assert.equal(readLogTail(home, CALL), null);
  fs.writeFileSync(logPathIn(home, CALL), 'AvgKeeper bought 2026-10-05: ETH 5.00 USDT.\nperiod_done\n');
  const ok = readLogTail(home, CALL);
  assert.equal(ok.crash, false);
  assert.deepEqual(ok.lines, ['AvgKeeper bought 2026-10-05: ETH 5.00 USDT.', 'period_done']);
});

test('readLogTail flags a crash only from the log\'s own last line, and caps the tail at LOG_TAIL_LINES', () => {
  const home = tmpDir('ak-store-');
  fs.mkdirSync(home, { recursive: true });
  const many = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
  fs.writeFileSync(logPathIn(home, CALL), `${many}\nTypeError: x is not a function\n    at foo (/x.mjs:1:1)\n`);
  const crashed = readLogTail(home, CALL);
  assert.equal(crashed.crash, true);
  assert.equal(crashed.lines.length, LOG_TAIL_LINES);
  assert.equal(crashed.lines.at(-1), 'at foo (/x.mjs:1:1)');
});

test('logStatusLines says nothing with no log yet, or when the last line reads like an ordinary finish', () => {
  const home = tmpDir('ak-store-');
  fs.mkdirSync(home, { recursive: true });
  assert.deepEqual(logStatusLines(home, CALL), []);
  fs.writeFileSync(logPathIn(home, CALL), 'Nothing to buy now: today is not a buy day.\n');
  assert.deepEqual(logStatusLines(home, CALL), []);
});

test('logStatusLines warns and shows the tail once the log ends in what looks like a crash', () => {
  const home = tmpDir('ak-store-');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(logPathIn(home, CALL), 'ReferenceError: x is not defined\n');
  const lines = logStatusLines(home, CALL);
  assert.match(lines[0], /^WARNING: the scheduled run's own log \(.*buy-t-live\.log\) ends with a line/);
  assert.ok(lines[0].includes(logPathIn(home, CALL)));
  assert.ok(lines.some((l) => l.includes('ReferenceError: x is not defined')), lines.join('\n'));
});

// Review finding (runlog.mjs:63, later): the log carries no time or run marker on any line (the cron redirect and
// launchd both just append plain output), so this WARNING could not say when the crash happened, and kept showing
// an already-fixed crash as current until the next scheduled run, up to a day away for a daily plan. The file's
// own mtime is the one fact this module can read without changing what the redirect writes.
test('logStatusLines names when the log was last written, from the file\'s own mtime', () => {
  const home = tmpDir('ak-store-');
  fs.mkdirSync(home, { recursive: true });
  const file = logPathIn(home, CALL);
  fs.writeFileSync(file, 'ReferenceError: x is not defined\n');
  const when = Date.UTC(2026, 9, 5, 10, 3);
  fs.utimesSync(file, when / 1000, when / 1000);
  const lines = logStatusLines(home, CALL);
  assert.match(lines[0], /last written 2026-10-05T10:03Z/, lines[0]);
});

// Review finding (schedule.mjs:75 area, later): "last written" printed a bare UTC ISO stamp while the very same
// status screen prints "Last run" and "Started" in the plan's own local time with its zone named; the two could
// read as three hours apart for the exact same instant. Given the plan's own timeZone, this now reads the same
// way lastRunLine already does (period.mjs's localParts and hhmm).
test('logStatusLines names when the log was last written in the plan\'s own local time, given a time zone', () => {
  const home = tmpDir('ak-store-');
  fs.mkdirSync(home, { recursive: true });
  const file = logPathIn(home, CALL);
  fs.writeFileSync(file, 'ReferenceError: x is not defined\n');
  const when = Date.UTC(2026, 9, 5, 10, 3); // 13:03 in Europe/Istanbul (UTC+3, no daylight saving)
  fs.utimesSync(file, when / 1000, when / 1000);
  const lines = logStatusLines(home, CALL, TZ);
  assert.match(lines[0], /last written 2026-10-05 13:03 \(Europe\/Istanbul\)/, lines[0]);
  assert.doesNotMatch(lines[0], /10:03Z/, lines[0]);
});
