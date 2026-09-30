// avgkeeper/tests/interop.test.mjs
// Item 2 of the 2026-09-27 release audit: a document a user or an agent reads is what they act from, so a command
// it gives that the dispatcher does not actually accept is a bug nobody notices until someone types it. This file
// makes that mechanical, the idea read from GridKeeper's own interop.test.mjs (this is AvgKeeper's own, much
// smaller check, written for what AvgKeeper's own README and SKILL.md actually claim): the README's install line
// matches guards.mjs's own CLI_INSTALL, the README sends the user to the folder Claude Code actually reads, and
// every backtick-quoted command in either document that opens with a real verb names only flags that verb's own
// VERBS entry (avgkeeper.mjs) accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VERBS } from '../scripts/avgkeeper.mjs';
import { CLI_INSTALL, BUILDER_CODE } from '../scripts/guards.mjs';
import { AK_ROOT } from './helpers.mjs';

const read = (f) => fs.readFileSync(path.join(AK_ROOT, f), 'utf8');
// Prose wraps across lines; one space for every run of whitespace lets a phrase match wherever a line breaks.
const norm = (s) => s.replace(/\s+/g, ' ');
const README = read('README.md');
const SKILL = read('SKILL.md');

test('the README installs the exact okx CLI version AvgKeeper pins', () => {
  // guards.mjs's CLI_INSTALL is the one reader (ProjectBuilder/CLAUDE.md rule 3): a README that names another
  // version is the README to fix, not this assertion.
  assert.ok(README.includes(CLI_INSTALL), `README.md's install line must read exactly: ${CLI_INSTALL}`);
});

test('the README sends the user to the folder Claude Code actually reads a personal skill from', () => {
  assert.ok(README.includes('~/.claude/skills'), 'README.md must name ~/.claude/skills');
  assert.match(README, /mkdir -p ~\/\.claude\/skills/, 'README.md gives the literal mkdir command, not just the folder name in prose');
});

// Every backtick span that opens with a real verb name: the flags after it, up to the closing backtick, are
// checked against that verb's own VERBS[verb].flags. A placeholder value (<p>, <address>, AVGPLAN, [...], a
// cadence like days:3) never starts with a lowercase letter followed by a word boundary right after a run of
// lowercase letters and dashes the way a verb name does, or never starts with -- the way a flag does, so neither
// is ever mistaken for a verb or counted as one of its flags.
const VERB_NAMES = Object.keys(VERBS);
function verbCommands(text) {
  const found = [];
  for (const span of text.match(/`[^`]+`/g) || []) {
    const body = span.slice(1, -1);
    const m = /^([a-z][a-z-]*)\b/.exec(body);
    if (!m || !VERB_NAMES.includes(m[1])) continue;
    const flags = [...body.matchAll(/--([A-Za-z][A-Za-z-]*)/g)].map((f) => f[1]);
    found.push({ span, verb: m[1], flags });
  }
  return found;
}

test('every backticked avgkeeper command in README.md and SKILL.md passes the dispatcher\'s flag check', () => {
  const bad = [];
  for (const [name, text] of [['README.md', README], ['SKILL.md', SKILL]]) {
    for (const { span, verb, flags } of verbCommands(text)) {
      for (const flag of flags) {
        if (!VERBS[verb].flags.includes(flag)) bad.push(`${name}: ${span} passes ${verb} --${flag}, which the dispatcher does not accept for it`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// Finding 11 of the 2026-09-27 release-readiness review: this build ships with BUILDER_CODE '', so preflight's gCode
// refuses every plan card and confirm outside owner test mode, demo and live alike, and the README promised a demo
// plan "proves the whole flow". The README says what a user meets, tied to the constant: when OKX issues a code and
// BUILDER_CODE is set, this fails until the section goes.
const NO_CODE_README ='This build carries no AI Builder Code from OKX yet, so `plan` refuses every plan, on a demo key and a live key alike, until an update that carries one, and nothing is ever bought.';
test('the README says this build carries no AI Builder Code exactly while BUILDER_CODE is empty', () => {
  assert.equal(README.includes(NO_CODE_README), BUILDER_CODE === '', `README.md must ${BUILDER_CODE === '' ? '' : 'no longer '}say: ${NO_CODE_README}`);
  assert.ok(!README.includes('proves the whole flow'), 'the demo promise a refused plan cannot keep is gone');
  assert.ok(norm(SKILL).includes('If `plan` refuses because this copy carries no AI Builder Code from OKX yet, relay that line as it is (rule 6): nothing can be bought until an update carries one, and nothing is wrong with the user\'s account.'), 'SKILL.md First run tells the agent what that refusal means');
});

// Finding 6 (and later item L7) of the 2026-09-27 release-readiness review: the README said a slept-through period
// is always skipped, true only for cron. launchd's StartCalendarInterval runs a missed job at the next wake, and
// dueNow buys then if the wake is still inside the same period. The README carries SKILL.md's own sentence.
const WAKE_RULE = 'launchd runs the job once at the next wake, and that run buys only for the period it wakes in.';
test('the README and SKILL.md give the same launchd wake rule, and the README splits sleep by scheduler', () => {
  assert.ok(norm(SKILL).includes(WAKE_RULE), 'SKILL.md');
  assert.ok(norm(README).includes(WAKE_RULE), 'README.md');
  assert.ok(norm(README).includes('With crontab, your computer has to be on and awake at the buy time: a buy time it sleeps through is missed, never bought later.'), 'the cron rule');
  assert.ok(!README.includes('a period the Mac sleeps through is skipped'), 'the cron-only claim stated for both is gone');
});

// Later item L8 of the 2026-09-27 release-readiness review: uninstalling AvgKeeper leaves the trade key live.
test('the README uninstall steps name the API key that outlives AvgKeeper', () => {
  assert.ok(norm(README).includes('The OKX API key itself stays saved in `~/.okx/config.toml` and stays live on OKX, with Trade on, until you or OKX delete it. If no other tool uses it, delete it on the OKX website (https://www.okx.com/account/my-api) and remove that profile\'s section from `~/.okx/config.toml` yourself, in a text editor.'));
});

// A parser that silently stopped matching anything would make the test above pass for the wrong reason.
test('verbCommands actually finds real commands in both documents', () => {
  const found = [...verbCommands(README), ...verbCommands(SKILL)];
  assert.ok(found.length >= 10, `only ${found.length} commands parsed out of both documents; the parser may have stopped working`);
  assert.ok(found.some((f) => f.verb === 'plan' && f.flags.includes('confirm')), 'the plan --confirm command must be among what was parsed');
});
