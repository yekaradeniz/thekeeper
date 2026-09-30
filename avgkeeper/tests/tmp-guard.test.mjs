import './tmp-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { OWN_TEMP, sweepStale, STALE_MS } from './tmp-guard.mjs';
import { AK_ROOT, withoutComments } from './helpers.mjs';

const GUARD = path.join(AK_ROOT, 'tests', 'tmp-guard.mjs');

// Review finding: this used to search the raw source for the bare string './helpers.mjs' or './tmp-guard.mjs', so
// a comment merely mentioning either file (documentation, a design note) satisfied it with no import at all.
// Comments are stripped first (withoutComments, helpers.mjs, the same reader cmdtext.test.mjs and
// independence.test.mjs already use), then an actual import statement is matched, not the bare quoted string.
const GUARD_IMPORT = /\bimport\s+['"]\.\/(?:helpers|tmp-guard)\.mjs['"]|\bimport\b[\s\S]{0,300}?\bfrom\s+['"]\.\/(?:helpers|tmp-guard)\.mjs['"]/;
function importsTempGuard(src) {
  return GUARD_IMPORT.test(withoutComments(src));
}

test('a child process that makes a temp dir leaves nothing behind', () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-box-'));
  const script = "import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; fs.mkdtempSync(path.join(os.tmpdir(), 'ak-child-'));";
  const r = spawnSync(process.execPath, ['--import', GUARD, '--input-type=module', '-e', script], { env: { ...process.env, TMPDIR: box + '/' } });
  assert.equal(r.status, 0, String(r.stderr));
  assert.deepEqual(fs.readdirSync(box), []);
});

test('a named import of mkdtempSync is tracked too', () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-box-'));
  const script = "import { mkdtempSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path'; mkdtempSync(path.join(os.tmpdir(), 'ak-named-'));";
  const r = spawnSync(process.execPath, ['--import', GUARD, '--input-type=module', '-e', script], { env: { ...process.env, TMPDIR: box + '/' } });
  assert.equal(r.status, 0, String(r.stderr));
  assert.deepEqual(fs.readdirSync(box), []);
});

test('the stale sweep removes only old dirs with this suite prefix', () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'ak-box-'));
  const old = path.join(box, 'ak-old-abcdef');
  const young = path.join(box, 'ak-new-abcdef');
  const other = path.join(box, 'gk-old-abcdef');
  for (const d of [old, young, other]) fs.mkdirSync(d);
  const past = (Date.now() - STALE_MS - 1000) / 1000;
  fs.utimesSync(old, past, past);
  fs.utimesSync(other, past, past);
  assert.equal(sweepStale(box), 1);
  assert.deepEqual(fs.readdirSync(box).sort(), ['ak-new-abcdef', 'gk-old-abcdef']);
});

// The prefix used to be `ak[a-z0-9-]*-`, which matched any name merely containing "ak" somewhere before a
// hyphen, so another application's own temp folder (akonadi's own naming) was swept as if it were this suite's.
test('OWN_TEMP rejects another app\'s ak-like folder and accepts this suite\'s own prefix', () => {
  assert.equal(OWN_TEMP.test('akonadi-Ab12Cd'), false);
  assert.equal(OWN_TEMP.test('ak-store-Ab12Cd'), true);
});

test('every mkdtempSync prefix in tests and tools matches OWN_TEMP', () => {
  const files = [];
  for (const dir of ['tests', 'tools']) {
    const abs = path.join(AK_ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (f.endsWith('.mjs')) files.push(path.join(abs, f));
  }
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:mkdtempSync\([^'"`]*|tmpDir\()['"`]([a-z0-9-]+)['"`]/g)) {
      assert.ok(OWN_TEMP.test(`${m[1]}abcdef`), `${path.basename(f)} uses prefix ${m[1]}`);
    }
  }
});

// Review finding (cards.test.mjs:1): this guard's own header says every test file loads it directly, but nothing
// checked that; cards.test.mjs and units.test.mjs imported neither it nor helpers.mjs (which imports it), so a
// single-file run of either (`node --test tests/cards.test.mjs`, no --import) leaked whatever temp dirs it made,
// with no error at all. Every test file in tests/ must import one or the other.
test('every tests/*.test.mjs file imports helpers.mjs or tmp-guard.mjs, so the guard loads on its own', () => {
  const dir = path.join(AK_ROOT, 'tests');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length > 10, 'sanity: this must actually scan the real tests directory');
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(importsTempGuard(src), `${f} imports neither helpers.mjs nor tmp-guard.mjs`);
  }
});

// New regression: the check above used to search the raw source for the bare string './helpers.mjs' or
// './tmp-guard.mjs', so a comment merely mentioning either file (documentation, a design note) satisfied it with
// no import at all. A single-file run of such a file (`node --test tests/x.test.mjs`, no --import) would leak
// whatever temp dirs it made, with no error at all.
test('a mention of the guard file inside a comment never counts as importing it', () => {
  const commentOnly = "// the temp guard lives in './helpers.mjs'\nimport test from 'node:test';\n";
  assert.equal(importsTempGuard(commentOnly), false, 'a comment alone must not satisfy the check');
  assert.equal(importsTempGuard("import './helpers.mjs';\n"), true);
  assert.equal(importsTempGuard('import \'./tmp-guard.mjs\';\n'), true);
  assert.equal(importsTempGuard("import { makeCtx } from './helpers.mjs';\n"), true);
});
