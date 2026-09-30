// avgkeeper/tools/mutate.mjs
// Mutation-test runner (design phase 2: "mutation tests on every guard"). For each mutation in
// tools/mutants.json it copies avgkeeper/ into a throwaway temp folder, applies exactly that one
// mutation to the copy, runs the copy's own full test suite, and records whether the suite noticed:
// KILLED (a test failed, so the mutation was caught) or SURVIVED (every test still passed, so nothing
// in the suite exercises what that line protects). The real source tree is never opened for writing.
// Usage: node tools/mutate.mjs [--only <mutant-id>]
// Exit codes: 0 every mutant graded KILLED; 1 at least one SURVIVED; 2 the unmutated suite fails in the copy; 3 the
// runner could not grade (a catalog it cannot read, an id it does not have, or a mutant whose search text does not
// match). A grader reading only the code never takes a mutant it could not grade for one that survived: until
// 2026-09-21 all four of the others shared 1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url)); // avgkeeper/
const CATALOG_PATH = path.join(ROOT, 'tools', 'mutants.json');

// Item 12 of the 2026-09-27 release audit: a run this tool ends by a signal (Ctrl-C, a killed test process) never
// reaches inCopy's own finally below, so its avgkeeper-mutant-* copy is left in the OS temp folder for good.
export const MUTANT_PREFIX = 'avgkeeper-mutant-';
export const STALE_MUTANT_MS = 3600000; // 1 hour: the whole catalog takes minutes, one mutant's copy seconds.

// Review finding (tools/mutate.mjs:194): this line was carried over from GridKeeper, whose own test file it named
// (tests/mutation-kill.test.mjs) does not exist here, and its own comment claimed a same-named test file "does
// exist for every scripts/*.mjs this catalog targets", which is false: planview.mjs, avgkeeper.mjs, SKILL.md and
// README.md each have mutants with no such file (their tests live elsewhere, e.g. avgkeeper.mjs's in
// entry.test.mjs and independence.test.mjs). Points at tests/ itself instead of a mapping this catalog cannot
// promise.
export const SURVIVED_HEADER = 'SURVIVED (add a test under tests/ for each; not every mutant here targets a scripts/*.mjs with its own same-named test file):';

// Runs once, before grading anything, and removes only this tool's own prefix, only directories, and only ones at
// least an hour old, so a mutant genuinely still being graded right now is never touched. Mirrors
// tests/tmp-guard.mjs's own sweepStale (same shape, this tool's own prefix): root and now stay overridable so a
// test never has to scan or depend on the real machine's temp folder.
export function sweepStaleMutantDirs(root = os.tmpdir(), now = Date.now()) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(MUTANT_PREFIX)) continue;
    const p = path.join(root, e.name);
    try {
      if (now - fs.lstatSync(p).mtimeMs < STALE_MUTANT_MS) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed += 1;
    } catch {
      // another process is using it right now, or it is already gone: leave it alone.
    }
  }
  return removed;
}

// Everything the test suite needs to run stand-alone: source, tests and fixtures. tools/ itself is
// never copied; a mutant never touches the runner that is grading it.
const SOURCE_ENTRIES = ['scripts', 'tests', 'references', 'SKILL.md', 'README.md', 'package.json', 'LICENSE'];

function loadCatalog() {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${CATALOG_PATH} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(list) || !list.length) throw new Error(`${CATALOG_PATH} holds no mutants`);
  for (const m of list) {
    // 'replace' may be the empty string on purpose (a mutant that deletes the matched line), so it is checked for
    // type only; every other field must be a non-empty string.
    for (const field of ['id', 'file', 'search', 'breaks']) {
      if (typeof m[field] !== 'string' || !m[field]) throw new Error(`mutant missing "${field}": ${JSON.stringify(m)}`);
    }
    if (typeof m.replace !== 'string') throw new Error(`mutant missing "replace": ${JSON.stringify(m)}`);
  }
  return list;
}

// The AvgKeeper suite reads nothing outside avgkeeper/, unlike GridKeeper's.
const OUTSIDE = [];

// Builds <base>/avgkeeper plus what the suite reads beside it, and returns the avgkeeper copy's path.
function copySource(base) {
  const dest = path.join(base, 'avgkeeper');
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of SOURCE_ENTRIES) {
    fs.cpSync(path.join(ROOT, entry), path.join(dest, entry), { recursive: true });
  }
  // OUTSIDE is empty for AvgKeeper, so this loop never runs; kept for parity with GridKeeper's runner.
  for (const [entry, how] of OUTSIDE) {
    const src = path.join(ROOT, '..', entry);
    if (!fs.existsSync(src)) continue;
    if (how === 'link') fs.symlinkSync(src, path.join(base, entry));
    else fs.cpSync(src, path.join(base, entry), { recursive: true });
  }
  return dest;
}

function inCopy(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'avgkeeper-mutant-'));
  try {
    return fn(copySource(base));
  } finally {
    for (const [entry, how] of OUTSIDE) {
      const p = path.join(base, entry);
      try {
        if (how === 'link' && fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
      } catch {
        // not created
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// Applies one mutation in place inside the copy. The search text must occur exactly once in the
// target file, so every mutation lands on the exact line it names, never on a look-alike elsewhere.
function applyMutant(dest, mutant) {
  const target = path.join(dest, mutant.file);
  const text = fs.readFileSync(target, 'utf8');
  const count = text.split(mutant.search).length - 1;
  if (count !== 1) {
    throw new Error(`search text found ${count} time(s) in ${mutant.file}, need exactly 1`);
  }
  fs.writeFileSync(target, text.replace(mutant.search, mutant.replace), 'utf8');
}

function runSuite(dest) {
  // The copy's own package.json test script, never a second spelling of it: that script carries the preload that
  // removes every temp directory the suite makes, and a mutant run that skipped it left one full suite's worth of
  // directories behind for every mutant graded.
  const testCommand = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).scripts.test;
  // The suite's temp folder is a folder inside this copy, so inCopy deletes whatever the suite left there along
  // with the copy. The preload removes its directories only at a normal exit; a test process a mutant ends some
  // other way (a signal, an abort) would otherwise leave them in the machine's temp folder once per catalog run.
  const tmp = path.join(path.dirname(dest), 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const result = spawnSync(testCommand, { cwd: dest, shell: true, encoding: 'utf8', env: { ...process.env, TMPDIR: `${tmp}${path.sep}` } });
  return { passed: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function runOne(mutant) {
  return inCopy((dest) => {
    applyMutant(dest, mutant);
    return runSuite(dest).passed ? 'SURVIVED' : 'KILLED';
  });
}

function main() {
  sweepStaleMutantDirs();
  let catalog;
  try {
    catalog = loadCatalog();
  } catch (e) {
    console.error(`CANNOT GRADE: ${e.message}`);
    process.exit(3);
  }
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const targets = only ? catalog.filter((m) => m.id === only) : catalog;
  if (only && !targets.length) {
    console.error(`CANNOT GRADE: no mutant with id "${only}" in ${CATALOG_PATH}`);
    process.exit(3);
  }

  // The unmutated suite must pass in the copy first, or the score means nothing.
  const base = inCopy((dest) => runSuite(dest));
  if (!base.passed) {
    console.error('BASELINE FAILS: the unmutated suite fails in the copy, so every mutant would read as killed.');
    for (const line of base.output.split('\n').filter((l) => /^\s*(\u2716|not ok)/.test(l)).slice(0, 10)) console.error(line);
    process.exit(2);
  }
  console.log('baseline: the unmutated suite passes in the copy');

  const results = [];
  for (const mutant of targets) {
    let verdict;
    let error = null;
    try {
      verdict = runOne(mutant);
    } catch (e) {
      verdict = 'ERROR';
      error = e.message;
    }
    results.push({ ...mutant, verdict, error });
    const tag = error ? `  [${error}]` : '';
    console.log(`${verdict.padEnd(9)} ${mutant.id}  (${mutant.file}) ${mutant.breaks}${tag}`);
  }

  const killed = results.filter((r) => r.verdict === 'KILLED');
  const survived = results.filter((r) => r.verdict === 'SURVIVED');
  const errored = results.filter((r) => r.verdict === 'ERROR');

  console.log('');
  console.log(`mutants: ${results.length}, killed: ${killed.length}, survived: ${survived.length}, errors: ${errored.length}`);
  if (survived.length) {
    console.log(SURVIVED_HEADER);
    for (const s of survived) console.log(`  ${s.id} (${s.file}): ${s.breaks}`);
  }
  if (errored.length) {
    console.log('ERRORS (fix the catalog entry, not the source):');
    for (const e of errored) console.log(`  ${e.id}: ${e.error}`);
  }

  process.exit(errored.length ? 3 : survived.length ? 1 : 0);
}

// Realpath, not a raw compare, the same reason avgkeeper.mjs's own isMain checks it this way: a script reached
// through a symlink still counts as main. Only a direct `node tools/mutate.mjs` run (or `npm run mutate`, which is
// exactly that) grades anything; importing this file for sweepStaleMutantDirs (tests/mutate.test.mjs) never
// triggers a full run as a side effect of the import.
const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main();
