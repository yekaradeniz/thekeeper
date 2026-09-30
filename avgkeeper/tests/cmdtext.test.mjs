// avgkeeper/tests/cmdtext.test.mjs
// commandText, and the guard behind it: there is no `avgkeeper` command on PATH (ProjectBuilder rule, every
// printed command runs exactly as printed and names the full path), so no script may print the bare word
// "avgkeeper" followed by a verb as if it were runnable.
import { AK_ROOT, withoutComments } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  commandText, ENTRY_SCRIPT, shWord, stableNode, cronWord,
} from '../scripts/cmdtext.mjs';
import { VERBS } from '../scripts/avgkeeper.mjs';

// Review finding (buy.mjs:368): cronWord's own '%' escape had no test. crontab reads an unescaped '%' in a command
// as a newline (and everything after it becomes the job's stdin), so a node or script path with one would silently
// truncate the scheduled command.
test('cronWord escapes a literal % for crontab, on top of shWord\'s own quoting', () => {
  // % is outside shWord's own safe set, so it is quoted first, then cronWord escapes the % inside that quoting.
  assert.equal(cronWord('/a%b'), "'/a\\%b'");
  assert.equal(cronWord('/plain/path'), '/plain/path');
  assert.equal(cronWord('/a b'), "'/a b'");
});

test('commandText is this node plus the entry script plus the given words, both paths through shWord', () => {
  const t = commandText('mail --pending --profile t');
  assert.equal(t, `${shWord(stableNode(process.env))} ${shWord(ENTRY_SCRIPT)} mail --pending --profile t`);
  assert.match(t, /avgkeeper\.mjs mail --pending --profile t$/);
  assert.ok(!t.startsWith('avgkeeper '), 'must not start with the bare, non-existent command');
});

test('commandText is deterministic across two calls in the same process', () => {
  assert.equal(commandText('doctor --profile t'), commandText('doctor --profile t'));
});

// ---------------------------------------------------------------------------------------------------------------
// The guard: every avgkeeper/scripts/*.mjs file's string and template literals, comments excluded, for the bare
// pattern `avgkeeper <verb> ` where <verb> is one of avgkeeper.mjs's own VERBS keys. This is the check that must
// fail red before the printed-command fix and pass green after it. withoutComments lives in tests/helpers.mjs.
// ---------------------------------------------------------------------------------------------------------------

const SCRIPTS_DIR = path.join(AK_ROOT, 'scripts');
const scriptFiles = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.mjs'));
const VERB_PATTERN = new RegExp(`avgkeeper (${Object.keys(VERBS).join('|')}) `);

test('withoutComments keeps a nested template literal intact and drops both comment kinds', () => {
  const src = "// a line comment with avgkeeper mail --pending\nconst a = `x ${o.profile ? `--profile ${o.profile}` : ''} avgkeeper mail --pending`;\n/* block avgkeeper doctor --profile p */\n";
  const cleaned = withoutComments(src);
  assert.ok(!cleaned.includes('avgkeeper mail --pending\n'), 'the line comment must be gone');
  assert.ok(!cleaned.includes('avgkeeper doctor --profile p'), 'the block comment must be gone');
  assert.ok(cleaned.includes('avgkeeper mail --pending`'), 'the nested template literal must survive intact');
});

test('no avgkeeper/scripts/*.mjs file prints the bare, non-existent "avgkeeper <verb>" command', () => {
  const offenders = [];
  for (const f of scriptFiles) {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
    const cleaned = withoutComments(src);
    const m = cleaned.match(VERB_PATTERN);
    if (m) offenders.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});
