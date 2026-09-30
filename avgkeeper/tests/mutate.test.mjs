// avgkeeper/tests/mutate.test.mjs
// Item 12 of the 2026-09-27 release audit: a mutation run ended by a signal (Ctrl-C, a killed test process) never
// reaches tools/mutate.mjs's own inCopy() finally, so its avgkeeper-mutant-* copy is left in the OS temp folder
// for good. sweepStaleMutantDirs runs once at startup and removes only this tool's own prefix, only directories,
// and only ones at least an hour old. Importing tools/mutate.mjs here for its exports must never itself trigger a
// full mutation run (isMain guards that, the same way avgkeeper.mjs's own entry does); the third test below proves
// the script still runs end to end when actually invoked as one.
//
// tools/ itself is deliberately never one of the entries tools/mutate.mjs copies into a mutant's own sandbox (its
// own comment: "a mutant never touches the runner that is grading it"), so inside that sandbox this file has
// nothing to import; a static import would crash the whole file with ERR_MODULE_NOT_FOUND before a single test
// could even report itself skipped, taking the copy's baseline run down with it. The dynamic import below only
// runs once MUTATE is confirmed to exist, and every test named `skip` when it does not: exactly the one place
// these tests are pointless anyway, since they test the tool doing the grading, not anything a mutation could
// have broken.
import { tmpDir } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MUTATE = fileURLToPath(new URL('../tools/mutate.mjs', import.meta.url));
const present = fs.existsSync(MUTATE);
const {
  sweepStaleMutantDirs, MUTANT_PREFIX, STALE_MUTANT_MS, SURVIVED_HEADER,
} = present ? await import('../tools/mutate.mjs') : {};

test('sweepStaleMutantDirs removes only its own prefix, only directories, and only ones over an hour old', { skip: !present }, () => {
  const root = tmpDir('ak-sweep-root-');
  const stale = path.join(root, `${MUTANT_PREFIX}stale1`);
  const fresh = path.join(root, `${MUTANT_PREFIX}fresh1`);
  const otherPrefix = path.join(root, 'other-mutant-stale1');
  const staleFile = path.join(root, `${MUTANT_PREFIX}stalefile`); // a file, never removed: only a directory is
  fs.mkdirSync(stale);
  fs.mkdirSync(fresh);
  fs.mkdirSync(otherPrefix);
  fs.writeFileSync(staleFile, 'x');
  const old = (Date.now() - STALE_MUTANT_MS - 60000) / 1000;
  for (const p of [stale, otherPrefix, staleFile]) fs.utimesSync(p, old, old);
  const removed = sweepStaleMutantDirs(root);
  assert.equal(removed, 1);
  assert.ok(!fs.existsSync(stale), 'a stale copy of this tool\'s own prefix is removed');
  assert.ok(fs.existsSync(fresh), 'a fresh copy, possibly still in flight, is left alone');
  assert.ok(fs.existsSync(otherPrefix), 'another prefix is never touched');
  assert.ok(fs.existsSync(staleFile), 'a file is never removed, only a directory');
});

test('sweepStaleMutantDirs answers 0 and does not throw on a root that does not exist', { skip: !present }, () => {
  const root = path.join(tmpDir('ak-sweep-root-'), 'nope');
  assert.equal(sweepStaleMutantDirs(root), 0);
});

// Confirms main() still runs end to end when this file is invoked as a script (the isMain guard did not silently
// break the CLI entry point), by way of the fastest exit path main() has: an unknown --only id, which fails right
// after loadCatalog, before ever running the (expensive) baseline suite. No mutant copy is ever made by this call.
test('mutate.mjs still runs as a script when invoked directly, sweep included', { skip: !present }, () => {
  const r = spawnSync(process.execPath, [MUTATE, '--only', 'no-such-mutant-id'], { encoding: 'utf8' });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no mutant with id "no-such-mutant-id"/);
});

// A mutant whose search text no longer occurs exactly once in its file cannot be graded: mutate.mjs's applyMutant
// throws, the run reports an ERROR, and the defence that mutant stood for goes unchecked. Three ids went stale this
// way when the stop code was rewritten (2026-09-30). Counted the way applyMutant counts (split on the search text),
// for every entry, so the next rewrite fails here in the ordinary suite instead of in a forty-minute catalog run.
test('every catalog entry\'s search text occurs exactly once in its file, and ids are unique', { skip: !present }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'mutants.json'), 'utf8'));
  assert.ok(catalog.length > 200, `the catalog holds ${catalog.length} entries`);
  const bad = [];
  const seen = new Set();
  const files = new Map();
  for (const m of catalog) {
    if (seen.has(m.id)) bad.push(`${m.id}: duplicate id`);
    seen.add(m.id);
    if (!files.has(m.file)) files.set(m.file, fs.readFileSync(path.join(root, m.file), 'utf8'));
    const count = files.get(m.file).split(m.search).length - 1;
    if (count !== 1) bad.push(`${m.id}: search text found ${count} time(s) in ${m.file}, need exactly 1`);
    if (m.replace === m.search) bad.push(`${m.id}: replace equals search, so the mutant changes nothing`);
  }
  assert.deepEqual(bad, []);
});

test('importing tools/mutate.mjs for its exports never triggers a full mutation run', { skip: !present }, () => {
  // Reaching this line at all, in well under a second, is the proof: a triggered run would spawn npm test inside
  // a temp copy of the whole suite and take on the order of a minute.
  assert.equal(typeof sweepStaleMutantDirs, 'function');
});

// Review finding (tools/mutate.mjs:194): the SURVIVED header carried over GridKeeper's own test file name, which
// does not exist in avgkeeper (tests/mutation-kill.test.mjs), and its own comment claimed a same-named test file
// "does exist for every scripts/*.mjs this catalog targets", which is false for planview.mjs, avgkeeper.mjs,
// SKILL.md and README.md (7 of 202 mutants at the time of the finding).
test('the SURVIVED header never names GridKeeper\'s own test file, or claims a same-named file exists for every target', { skip: !present }, () => {
  assert.doesNotMatch(SURVIVED_HEADER, /mutation-kill\.test\.mjs/);
  assert.doesNotMatch(SURVIVED_HEADER, /<module>\.test\.mjs/, 'a mutant on planview.mjs, avgkeeper.mjs, SKILL.md or README.md has no such same-named file');
  assert.match(SURVIVED_HEADER, /tests\//);
});
