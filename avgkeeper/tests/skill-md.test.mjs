// avgkeeper/tests/skill-md.test.mjs
import { AK_ROOT } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VERBS } from '../scripts/avgkeeper.mjs';

const read = (f) => fs.readFileSync(path.join(AK_ROOT, f), 'utf8');
const EM_DASH = String.fromCharCode(0x2014);
// Prose in SKILL.md wraps across lines for readability; a plain space in place of every run of whitespace lets a
// test match a phrase without pinning the exact column each line happens to wrap at.
const norm = (s) => s.replace(/\s+/g, ' ');

test('SKILL.md has front matter and names every verb', () => {
  const s = read('SKILL.md');
  assert.match(s, /^---\nname: avgkeeper\ndescription: .+\nlicense: MIT\n---\n/);
  for (const v of Object.keys(VERBS)) assert.ok(s.includes(`\`${v}`), v);
});

// Section 10: the hourly cadence choice, with its own --at form.
test('SKILL.md lists every hour as a choice, with --every hour and --at :MM', () => {
  const s = read('SKILL.md');
  assert.match(s, /How often: every hour, every day, every N days, weekly on a weekday, or monthly on a day \(`--every hour` with `--at :MM`/);
});

// Section 10: what the agent relays about money reads per period, not per day. An hourly plan buys up to 24 times
// a day, a new hourly plan can buy on a date a daily plan bought, and a slept-through hour is never caught up, so
// a day-only sentence here would be a safety promise the code does not keep.
test('SKILL.md states the --at default, the slept-through rule and the one-buy rule per period', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('Optional: the time (`--at 10:00`, default 10:00 machine time; for an hourly plan the minute past each hour, `--at :30`, default :05)'), 'the hourly --at form and default');
  assert.ok(s.includes('A period the Mac sleeps through (a day, or an hour for an hourly plan) is never bought later.'), 'the slept-through rule');
  assert.ok(s.includes('launchd runs the job once at the next wake, and that run buys only for the period it wakes in.'), 'the wake rule');
  assert.ok(s.includes('At most one buy per period per profile and mode, whatever plan made it.'), 'the one-buy rule');
  assert.ok(s.includes('For a daily or longer plan the period is the calendar day; for an hourly plan it is the local hour.'));
  assert.ok(s.includes('A new hourly plan can still buy on a day a daily plan already bought.'));
  assert.ok(s.includes('A new daily or longer plan does not buy on a day an hourly plan already bought or skipped in.'));
  assert.ok(!s.includes('calendar day: replacing a plan never buys a second time'), 'the day-only promise is gone');
  assert.ok(!s.includes('if that is still the same day'), 'the day-only wake rule is gone');
});

test('SKILL.md keeps the money rules', () => {
  const s = read('SKILL.md');
  assert.match(s, /Never run `buy` yourself/);
  assert.match(s, /Never type or pass `--confirm AVGPLAN` unless the user's latest message is the word AVGPLAN, in any letter case/);
  assert.match(s, /Never set `AVGKEEPER_OWNER_TEST`/);
  assert.match(s, /Ask the user for each of these/);
});

// 2026-09-28: a phone keyboard capitalizes the first letter, so a user who typed AVGPLAN on their phone got
// Avgplan; isConfirmWord (plan.mjs) now accepts the word in any letter case. Rule 2 still refuses every other
// shape (extra words, punctuation, a near spelling) and still forbids inferring the word from agreement.
test('SKILL.md rule 2 accepts any letter case but refuses other words, punctuation, a near spelling or a look-alike letter, and never infers the word from agreement', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes("Never type or pass `--confirm AVGPLAN` unless the user's latest message is the word AVGPLAN, in any letter case (for example `Avgplan` or `avgplan`), and nothing else, sent after they saw the plan card, with exactly the flags that card was made from."));
  assert.ok(s.includes('A message with other words, punctuation, a near spelling, or look-alike letters from another alphabet or fullwidth letters is not the word; never infer it from an agreement word like `ok`, `yes`, `evet` or `devam`.'));
  assert.ok(!s.includes('is exactly `AVGPLAN`'), 'the old, case-sensitive wording is gone');
});

// 2026-09-28 review: this sentence used to read "Only after the user types the word AVGPLAN, in any letter case,
// run the same command...", which is looser than rule 2. "types the word" can be read as "the message contains
// the word", so a user's "ok AVGPLAN" or "evet, AVGPLAN devam" would satisfy a literal reading of this sentence
// though rule 2 forbids it (rule 2 requires the latest message to be the word "and nothing else"). This sentence
// now repeats rule 2's own wording instead of restating it more loosely.
test('SKILL.md "Making a plan" tells the agent the confirm word works in any letter case and nothing else', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes("Only after the user's latest message is the word AVGPLAN and nothing else, in any letter case (rule 2), run the same command with `--confirm AVGPLAN`."));
  const making = s.slice(s.indexOf('## Making a plan'));
  assert.ok(making.includes('and nothing else'), 'the Making a plan section repeats the nothing-else guard, not a looser paraphrase');
});

test('SKILL.md tells the agent never to write the notify command', () => {
  const s = read('SKILL.md');
  assert.match(s, /Never write, edit or suggest a value for the `notify` key in ~\/\.avgkeeper\/config\.json/);
  assert.match(s, /the command receives one line on stdin/);
});

// Spec section 9: the fifth question, asked after the coin list and before the plan card.
test('SKILL.md asks a fifth question about mail, after the coins and before the card', () => {
  const s = read('SKILL.md');
  const coins = s.indexOf('Which coins:');
  const q5 = s.indexOf('Do you want email notices?');
  const card = s.indexOf('Run `plan` with those flags and show the card word for word.');
  assert.ok(coins > -1 && q5 > -1 && card > -1);
  assert.ok(coins < q5 && q5 < card, 'question 5 must sit between the coin list and the plan card');
  assert.match(s, /Do you want email notices\? If yes: only problems, or every buy with its details\?/);
});

// Spec section 9 / research doc section 6: the address step, also before the card.
test('SKILL.md gives the address step: a connected mail tool first, then ask, then read it back', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('Look for a connected mail tool.'));
  assert.ok(s.includes("offer the address of the account it sends from, read from that tool's own profile call or, when it has none, the sender field of one message the user sent from it"));
  assert.ok(s.includes('if no mail tool is connected, ask the user to type an address.'));
  assert.ok(s.includes('Read the chosen address back to the user in full'));
  assert.ok(s.includes('`mail --to <address>`, then `mail --level problems` (only problems) or `mail --level all` (every buy)'));
  const address = s.indexOf('Look for a connected mail tool');
  const card = s.indexOf('Run `plan` with those flags and show the card word for word.');
  assert.ok(address > -1 && card > -1 && address < card, 'the address step must sit before the plan card, so the card can show it');
});

// Research doc section 6: the user confirms the address before it is recorded; an offered address is a question.
test('SKILL.md records the address only after the user confirms it', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('ask whether notices should go to that address or to another one they type'));
  assert.ok(s.includes('Read the chosen address back to the user in full and wait for them to confirm it.'));
  assert.ok(s.includes('Only after they confirm it, run `mail --to <address>`'));
  assert.ok(s.indexOf('wait for them to confirm it') < s.indexOf('`mail --to <address>`, then'), 'the confirm comes before the command');
});

// mail is one account-wide setting that outlives plans: a no must turn off what an earlier plan turned on.
test('SKILL.md turns mail off when question 5 is no and an earlier plan left it on', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('If question 5 was no, run `mail`. If its Level line is not `off`'));
  assert.ok(s.includes('then run `mail --level off`'));
  assert.ok(!s.includes('`mail --level off` is not needed'));
});

// Spec section 9: mail.command is a user-written key, same discipline as notify's own key (agent rule 8).
test('SKILL.md tells the agent never to write the mail command, and names its three channels', () => {
  const s = read('SKILL.md');
  assert.match(s, /Never write, edit or suggest a value for the `mail\.command` key in ~\/\.avgkeeper\/config\.json/);
  assert.match(s, /the whole notice body on stdin/);
  assert.match(s, /`AVGKEEPER_SUBJECT`/);
  assert.match(s, /`AVGKEEPER_NOTIFY_EMAIL`/);
  assert.ok(norm(s).includes('Never edit `mail.to` by hand either: set it only with `mail --to`, which checks it.'));
});

// Spec section 9 / research doc section 6: sending a pending notice is the assistant's own action, asked for
// every session, never carried over from an earlier yes. Notices are kept per profile (every notice carries the
// buy's profile), so the command names it: a bare `mail --pending` would list none of them.
test('SKILL.md asks before sending a pending notice, every session, and records only what it actually sent', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('Whenever this skill is used on a profile, run `mail --pending --profile <p>` (add `--demo` for the demo account).'));
  assert.ok(s.includes('If it lists notices, ask the user before sending any of them with your own connected mail tool.'));
  assert.ok(s.includes('A yes covers that one session only; ask again next session, never carry a yes forward.'));
  assert.ok(s.includes('For each notice you actually send this way, and no others, run the command printed after `Record it once it is actually sent:` exactly as shown.'));
  // Section 10: an hourly notice id holds a space; typed by hand from the bare form it splits in two and is refused.
  assert.ok(s.includes("It is `mail --sent <id> --profile <p>`, with the id quoted when it holds a space, as an hourly plan's ids do."));
});

// Research doc rule 2 and section 4, carried into lane 2: the mail the agent sends is the one AvgKeeper prepared.
test('SKILL.md sends each notice to its own address, word for word, and asks when the address changed', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('Send each notice to the address on its `to:` line, with its subject and body exactly as printed, word for word; never summarise or reword them.'));
  assert.ok(s.includes('If a notice shows the WARNING that the address now set is different, ask the user which address to use before sending it.'));
});

// The Verbs table lists mail alongside every other verb, with the profile flag the pending list needs.
test('SKILL.md lists mail in the Verbs table', () => {
  const s = read('SKILL.md');
  assert.match(s, /\| `mail \[--profile <p>\]` \|/);
  assert.match(s, /\| `mail --pending --profile <p>` \|/);
  assert.match(s, /\| `mail --sent <id> --profile <p>` \|/);
  assert.doesNotMatch(s, /`mail --pending`/, 'every mention of mail --pending names the profile');
});

// Item 11 of the 2026-09-27 release audit: a Type column (READ or WRITE), pinned per verb so a future verb cannot
// silently drop it, plus the Network calls and First run sections and the instruction to prove the schedule with
// buy --smoke once it is installed.
test('SKILL.md gives the Verbs table a Type column, READ or WRITE, and defines what the two mean', () => {
  const s = read('SKILL.md');
  assert.match(s, /\| Verb \| Type \| What it does \|/);
  const rows = {
    'holdings --profile <p>': 'READ',
    'plan --profile <p> --budget --every --method \\[\\.\\.\\.\\]': 'READ',
    'plan \\.\\.\\. --confirm AVGPLAN': 'WRITE',
    'buy --profile <p>': 'WRITE',
    'status --profile <p>': 'READ',
    'stop --profile <p>': 'WRITE',
    'doctor --profile <p>': 'READ',
    'buy --smoke \\[--launchd\\] --profile <p>': 'READ',
    'buy --dry-run --profile <p>': 'READ',
    'mail --sent <id> --profile <p>': 'WRITE',
    'mail --pending --profile <p>': 'READ',
  };
  for (const [verb, type] of Object.entries(rows)) {
    assert.match(s, new RegExp(`\\| \`${verb}\` \\| ${type} \\|`), verb);
  }
  assert.match(s, /Type: WRITE starts, replaces or ends a plan/);
});

// Finding 8 of the 2026-09-27 release-readiness review: the card is READ, yet plan.mjs appends a plan_card line to
// the ledger on every card (freshCard needs it), so "READ never touches" the ledger was false. The definition now
// says what READ does promise, and names both READ rows that still write a file.
test('SKILL.md defines READ by what it never does, and names the card\'s own ledger line', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('Type: WRITE starts, replaces or ends a plan, or records an order or a sent notice, in the ledger (`~/.avgkeeper/ledger.jsonl`, the record of what a plan and its orders did). READ never does any of those and never sends an order.'), 'the definition');
  assert.ok(s.includes('the plan card appends one `plan_card` line to the ledger, the record `--confirm` checks the card against'), 'the card row names its own ledger line');
  assert.ok(!s.includes('READ never touches it'), 'the false promise is gone');
});

test('SKILL.md has a Network calls section naming which verbs reach OKX', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('## Network calls'));
  assert.ok(s.includes('These reach OKX, through the okx CLI, every time they run: `holdings`, `plan` (both the card and `--confirm`), `doctor`, and every form of `buy`'));
  assert.ok(s.includes('These never call OKX, only local files under `~/.avgkeeper`: `status`, `stop`, `notify`, and every form of `mail`.'));
});

test('SKILL.md has a First run section that ends in proving the schedule with buy --smoke', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('## First run'));
  const firstRun = s.indexOf('## First run');
  const verbs = s.indexOf('## Verbs');
  assert.ok(firstRun > -1 && verbs > -1 && firstRun < verbs, 'First run sits before the Verbs table');
  assert.ok(s.includes('Run `buy --smoke --profile <p>` (add `--launchd` too when the receipt or `doctor` says launchd) to prove the installed line actually runs'));
});

// 2026-09-30: AVGPLAN installs the schedule and stop removes it. The agent still never edits a crontab or a
// LaunchAgent itself. The old wording ("Never install a schedule", "the user installs one") must not come back.
test('SKILL.md rule 3: AvgKeeper installs its own schedule on AVGPLAN, removes it on stop, doctor only reads', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('3. Never edit a crontab or a LaunchAgent yourself. AvgKeeper installs its own schedule entry when the user confirms with AVGPLAN and removes it on `stop`; `doctor` only reads it; `buy --smoke` proves the line runs.'));
  assert.doesNotMatch(s, /Never install a schedule/);
  assert.doesNotMatch(s, /the user installs one/);
  assert.doesNotMatch(s, /this skill never installs it/);
  assert.ok(s.includes('Relay its receipt word for word, including the line that starts `Schedule installed` with any WARNING lines under it, or, when the install failed, the `FAIL:` line'));
  assert.ok(s.includes('It includes a line saying that typing AVGPLAN also adds AvgKeeper\'s own schedule entry on this computer; do not drop it.'));
  assert.ok(s.includes('If `plan` refuses the profile name because it ends in `.demo`, ask the user for another okx profile name.'));
  assert.ok(s.includes('If `stop` prints that the schedule could not be removed, run `doctor`'));
  assert.doesNotMatch(s, /run doctor again|installed a line by hand|line `doctor` prints/);
  assert.ok(s.includes('Run `doctor` only to check, or when the receipt says FAIL.'));
  assert.ok(s.includes('It ends the plan and removes AvgKeeper\'s own schedule entry'));
});

test('README.md says AVGPLAN installs the schedule and stop removes it', () => {
  const r = norm(read('README.md'));
  assert.ok(r.includes('Typing AVGPLAN to confirm a plan installs it for you'));
  assert.ok(r.includes('The receipt shows a `Schedule installed` line'));
  // The receipt prints "Schedule installed (<scheduler>): ...", never "Schedule installed:" (plan.mjs).
  assert.ok(!r.includes('`Schedule installed:`'));
  assert.ok(!r.includes('The receipt ends with `Schedule installed`'));
  assert.ok(r.includes('it shows a `FAIL:` line instead, which says whether an earlier AvgKeeper entry may still run the plan; then ask your agent for `doctor`, which prints the line to install by hand.'));
  assert.ok(r.includes('If `stop` prints that the schedule could not be removed, ask your agent for `doctor`'));
  assert.doesNotMatch(r, /you installed a line by hand/);
  assert.ok(r.includes('removes the schedule entry AvgKeeper installed (`Schedule removed.`)'));
  assert.doesNotMatch(r, /this skill never installs a schedule/);
  assert.doesNotMatch(r, /yourself: this skill/);
});

// Every string the docs quote from the code's receipts must still be in the code.
test('the receipt strings the docs quote exist in the code', () => {
  const plan = read('scripts/plan.mjs');
  const manage = read('scripts/manage.mjs');
  const sched = read('scripts/schedule.mjs');
  assert.ok(plan.includes('Schedule installed (') && plan.includes('FAIL: the plan is on, but AvgKeeper could not install its schedule'));
  assert.ok(manage.includes('Schedule removed.') && manage.includes('The schedule could not be removed'));
  assert.ok(sched.includes('Schedule: installed ('));
});

// Finding 14 of the 2026-09-27 release-readiness review: an agent with only SKILL.md had no setup path, and to find
// a profile it might run `okx config show --json`, which prints every saved key, secret and passphrase unmasked.
// Step 0 asks the user for the name, forbids reading the okx config, and sends a user with no profile to the key
// guide to run okx config init themselves.
test('SKILL.md First run starts with step 0: ask for the profile name, never read the okx config, the user runs okx config init', () => {
  const s = norm(read('SKILL.md'));
  const step0 = s.indexOf('0. Ask the user for the okx profile name they chose when they saved their API key');
  assert.ok(step0 > s.indexOf('## First run') && step0 < s.indexOf('1. `holdings --profile <p>`'), 'step 0 opens First run');
  assert.ok(s.includes('Never run `okx config show`, `okx config list-profile` or read `~/.okx/config.toml` yourself: the profile name comes from the user, and the file and `okx config show --json` hold every saved key, secret and passphrase in plain text.'));
  assert.ok(s.includes('If they have no profile yet, point them to `references/api-key-setup.md` in this skill folder, so they run `okx config init` themselves, in their own Terminal. Never run it for them.'));
  assert.ok(fs.existsSync(path.join(AK_ROOT, 'references', 'api-key-setup.md')), 'the guide step 0 names ships with the skill');
});

// Item 3 of the 2026-09-27 release audit: SKILL.md tells the agent how to pause and how to point the user at
// uninstalling, without running any of the destructive parts itself.
// Review finding (guards.mjs:44): the rule against reading the okx config sat only under First run step 0, a
// one-time step, although the failure it guards against (an agent reaching for `okx config show` to find a
// profile or diagnose a key) can come up any time this skill runs, not only on the first run. It now also stands
// as a standing rule for the agent.
// Review finding (buy.mjs:442, blocker): the Verbs table row must not promise more than a dry run now checks.
test('SKILL.md\'s buy --dry-run row names the gates it checks, not just "what a buy would do"', () => {
  const s = read('SKILL.md');
  assert.match(s, /\| `buy --dry-run --profile <p>` \| READ \| What a real buy would do right now, checking the same gates it would \(halted, a stale buy lock, an unsettled send, not due, no coin in loss, every coin below OKX's minimum, free USDT below the budget\)\. Sends nothing\. \|/);
});

test('SKILL.md keeps "never read the okx config" as a standing rule, not only a First run step', () => {
  const s = norm(read('SKILL.md'));
  const rules = s.indexOf('## Rules for the agent');
  const making = s.indexOf('## Making a plan');
  assert.ok(rules > -1 && making > -1 && rules < making);
  const rulesSection = s.slice(rules, making);
  assert.ok(rulesSection.includes('Never run `okx config show`, `okx config list-profile` or read `~/.okx/config.toml` yourself'), 'Rules for the agent');
});

// Review finding (SKILL.md:79): smoke does run the user's own notify and mail commands with a test message, so
// "it sends nothing" is false whenever either is set; the agent could tell the user a real message would not go
// out when it just did.
test('SKILL.md never claims buy --smoke sends nothing', () => {
  const s = norm(read('SKILL.md'));
  assert.doesNotMatch(s, /This is a dry run: it sends nothing\./);
  assert.match(s, /It sends no order\. If a notify or mail command is set, it sends one test message through each\./);
});

test('SKILL.md has a Pause and uninstall section', () => {
  const s = norm(read('SKILL.md'));
  assert.ok(s.includes('## Pause and uninstall'));
  assert.ok(s.includes('To stop buying without touching anything else, run `stop`.'));
  assert.ok(s.includes('even after `stop`. When nothing is installed it says so and prints no commands.'));
  assert.ok(s.includes('`README.md`\'s own "Pause and uninstall" section'));
});

test('no em dash in any file this skill ships', () => {
  const files = ['SKILL.md', 'README.md', ...fs.readdirSync(path.join(AK_ROOT, 'scripts')).map((f) => `scripts/${f}`)];
  for (const f of files) assert.ok(!read(f).includes(EM_DASH), f);
});
