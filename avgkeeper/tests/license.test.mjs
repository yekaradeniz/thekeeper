// avgkeeper/tests/license.test.mjs
// AvgKeeper ships under MIT (the owner's own choice, separate from GridKeeper's Apache-2.0, item 5 of the
// 2026-09-27 release audit). Three places name it: the license file itself, SKILL.md's front matter (what the
// marketplace listing reads) and package.json. A marketplace page naming one license while the download carries
// another is the failure this test exists to catch, so all three are read here and compared, not just present.
import { AK_ROOT } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (f) => fs.readFileSync(path.join(AK_ROOT, f), 'utf8');

test('LICENSE holds the standard MIT text with the owner\'s copyright line', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License\n/);
  assert.match(license, /\nCopyright \(c\) 2026 Yunus Emre Karadeniz\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test('SKILL.md front matter and package.json both name MIT, agreeing with LICENSE', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /^---\nname: avgkeeper\ndescription: .+\nlicense: MIT\n---\n/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.license, 'MIT');
  // All three read the same word: a licence a marketplace page could show as MIT while the code itself carries a
  // different one in package.json would be worse than naming none at all.
  assert.ok(read('LICENSE').startsWith('MIT License'));
});
