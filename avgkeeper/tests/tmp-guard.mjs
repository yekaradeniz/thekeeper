// avgkeeper/tests/tmp-guard.mjs
//
// Loaded by every test process, whatever started it: the --import in package.json's test script, tests/helpers.mjs,
// and a direct `import './tmp-guard.mjs'` in every test file that does not use helpers.mjs. It does two things.
// It records each temp directory the process makes with fs.mkdtempSync and removes all of them when the process
// exits, so no test file has to remember to clean up. And when it loads, it removes this suite's own directories
// that an earlier run left behind and that are more than an hour old, so a leak nobody has found yet cannot build up.
//
// Why a guard at all. Until 2026-09-16 nothing removed these directories, and one full `npm test` left 1,724 of
// them in the machine's temp folder; every mutant the mutation runner grades runs the whole suite again. Over the
// life of this repo that came to millions of directories. It filled a 460 GB disk to zero bytes free, and the temp
// folder's own entry list grew to 733 MB, so any application that scans that folder when it starts (Steam does)
// hung on launch, and the machine was eventually formatted. A rule every file has to follow is a rule some file
// will not follow, so this is one mechanism that every test process loads.
//
// Three holes found since, each now closed and each with a test in tests/tmp-guard.test.mjs:
// - 2026-09-19: the patch reached only `import fs from 'node:fs'`. A named import, an `import * as` namespace and
//   `await import('node:fs')` kept the original function, until syncBuiltinESMExports (below) copied the patch
//   into node:fs's ES module exports. Mutant crontab-contents-echoed left one gk-cron- directory per catalog run.
// - 2026-09-19: the guard loaded only through the npm script's --import. Agents ran single files as plain
//   `node --test tests/x.test.mjs`, which skips it, and 1,648 gk- directories piled up in one hour. The guard now
//   loads with the test files themselves.
// - 2026-09-19: a process killed by a signal never runs its exit handler. tools/mutate.mjs gives each mutant's
//   suite a TMPDIR inside the copy it deletes, and the stale sweep below removes anything else within the hour.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

// The names this suite and tools/mutate.mjs give their temp directories: an ak- prefix (one or more hyphenated
// words, e.g. ak-store-, ak-runner-mutant-) or avgkeeper-mutant-, then the six characters mkdtempSync adds.
// tests/tmp-guard.test.mjs checks that every mkdtempSync prefix in tests/ and tools/ matches, so a new prefix
// cannot slip outside the sweep. The old pattern (`ak[a-z0-9-]*-`) matched any name merely containing "ak", so
// another application's own folder, such as akonadi's `akonadi-Ab12Cd`, was swept as if it were this suite's own.
// Requiring the prefix to start with "ak-" closes that. Nothing else in the temp folder is ever touched.
export const OWN_TEMP = /^(ak-(?:[a-z0-9]+-)*|avgkeeper-mutant-)[A-Za-z0-9]{6}$/;
// Older than this, a directory cannot belong to a test still running: a full suite takes seconds, the whole
// mutation catalog about 40 minutes, and each mutant's copy lives for seconds.
export const STALE_MS = 3600000;
// The sweep never holds a test up: in a temp folder with millions of entries it stops after this long and the
// next test process carries on from wherever the directory listing starts again.
const SWEEP_BUDGET_MS = 500;

export function sweepStale(root = os.tmpdir(), now = Date.now()) {
  const started = Date.now();
  let removed = 0;
  let dir;
  try {
    dir = fs.opendirSync(root);
  } catch {
    return removed;
  }
  try {
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      if (Date.now() - started > SWEEP_BUDGET_MS) break;
      if (!e.isDirectory() || !OWN_TEMP.test(e.name)) continue;
      const p = path.join(root, e.name);
      try {
        if (now - fs.lstatSync(p).mtimeMs < STALE_MS) continue;
        fs.rmSync(p, { recursive: true, force: true });
        removed += 1;
      } catch {
        // another test process removed it first, which is the outcome this wants
      }
    }
  } finally {
    dir.closeSync();
  }
  return removed;
}

const made = [];
const original = fs.mkdtempSync;

fs.mkdtempSync = function mkdtempSyncTracked(...args) {
  const dir = original.apply(this, args);
  made.push(dir);
  return dir;
};
syncBuiltinESMExports();

sweepStale();

process.on('exit', () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // a directory already gone is the outcome this wants
    }
  }
});
