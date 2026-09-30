// avgkeeper/scripts/guards.mjs
// Checks that run before any buy and any plan. Each returns null to pass or a refusal. parseVersion, cmpVersion,
// resolveSite and the withdraw rule are GridKeeper's (gridkeeper/scripts/guards.mjs).
import { ledgerSchema, LEDGER_SCHEMA, displayHomePath } from './store.mjs';
import { maxGapDays } from './period.mjs';
import { okxMessage, reasonOf, unreachableLine } from './runner.mjs';

// The AI Builder Code is a literal, never an environment variable. Empty until OKX issues it; every write refuses
// until then, except in owner test mode, where no code is ever sent. Declared with `let`, not inlined at every call
// site, only so tests/guards.test.mjs can prove the "a code is set" text and order argument through the one seam
// below; no other code ever writes to it, and it always ships as '' until OKX issues a real one.
export let BUILDER_CODE = '';
// The one seam allowed to change BUILDER_CODE, and only from inside this test process: never call this from
// anywhere but a test. Every AvgKeeper import of BUILDER_CODE reads it live (an ES module binding, not a copy), so
// a test can flip it before calling into plan.mjs, buy.mjs or schedule.mjs and see every one of them agree.
export function setBuilderCodeForTest(code) {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('setBuilderCodeForTest is for tests only');
  BUILDER_CODE = code;
}
export const OWNER_TEST_ENV = 'AVGKEEPER_OWNER_TEST';
export const isOwnerTest = (env) => Boolean(env && env[OWNER_TEST_ENV] === '1');

// Item 4 of the 2026-09-27 release audit: the three sentences a user reads about whether their orders carry OKX's
// AI Builder Code, from BUILDER_CODE and owner test mode, chosen in this one reader for the plan card, the receipt
// and doctor (rule 3, one fact one reader). Owner test mode always wins over a code that is set: buy.mjs sends ''
// as the code under it (buyPeriod), so no order is ever attributed while it is on, whatever BUILDER_CODE holds.
export function builderDisclosure(ownerTest) {
  if (ownerTest) return 'OWNER TEST: no code is sent, so nothing is attributed.';
  if (BUILDER_CODE) return "Orders carry OKX's AI Builder Code.";
  return 'This copy of AvgKeeper carries no code yet, so it buys nothing.';
}
export const CODE_PATTERN = /^[A-Za-z0-9]{1,16}$/;
export const MIN_CLI = [1, 4, 4];
export const CLI_INSTALL = 'npm install -g @okx_ai/okx-trade-cli@1.4.6';
export const NO_CLI_LINE = `AvgKeeper cannot reach OKX: no okx CLI was found on PATH. Install it: ${CLI_INSTALL}`;
export const PROFILE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

// A launchd label is com.avgkeeper.buy.<profile>, plus .demo for a demo plan. A profile whose own name ends in .demo
// would therefore share a label, and a plist file, with the demo plan of the profile before the dot: profile x in
// demo and profile x.demo live are both com.avgkeeper.buy.x.demo, and installing or stopping one would replace or
// remove the other's schedule. A plan on such a name is refused at the card and at confirm (plan.mjs). Existing
// labels are not renamed. Case-insensitive, so x.DEMO cannot slip past on a case-insensitive file system.
export const DEMO_SUFFIX_NAME = /\.demo$/i;
export function profileNameRefusal(name) {
  if (!DEMO_SUFFIX_NAME.test(String(name))) return null;
  const base = String(name).slice(0, -'.demo'.length);
  return `REFUSED: a plan cannot use profile name ${name}, because a name ending in .demo gets the same launchd schedule name as ${base || 'the profile before the dot'} in demo mode (com.avgkeeper.buy.${name}), so each would replace or remove the other's schedule. Use another okx profile name.`;
}

export const refusal = (guard, msg) => ({ guard, kind: 'REFUSED', msg: `REFUSED: ${msg}` });

// The one plain line for a failure a verb did not handle itself: avgkeeper.mjs's main() prints it for every verb,
// and doctor prints it for a preflight that could not finish, then goes on with what it can say from local files
// (finding 12 of the 2026-09-27 release-readiness review). One writer, so the two never word it apart.
// Review finding (guards.mjs:44, plan and doctor's own copy of probe K1): a profile with no key saved locally
// ("Error: No credentials found.") is not OKX rejecting a key it never saw, and "Check the key in the okx config"
// named no one who should do it. holdings already tells the two apart (isNoKeySavedFailure, noKeySavedLine); this
// is the one reader for every other verb (rule 3).
export function failureLine(e, profile) {
  if (e && e.kind === 'auth') {
    if (isNoKeySavedFailure(e)) return `REFUSED: ${noKeySavedLine(profile)}`;
    return `OKX did not accept API key ${profile} (${reasonOf(e)}). Check this key on the OKX website; if it was deleted, make a new one and save it yourself with okx config init.`;
  }
  if (e && e.kind === 'missing') return NO_CLI_LINE;
  if (e && e.kind === 'network') return unreachableLine(e);
  return String((e && e.message) || e);
}

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function gCliVersion(text) {
  const v = parseVersion(text);
  if (!v || cmpVersion(v, MIN_CLI) < 0) return refusal('cli', `okx CLI ${v ? v.join('.') : 'unknown'} is below ${MIN_CLI.join('.')}. Run: ${CLI_INSTALL}`);
  return null;
}

export function gHelpFlags(helpText) {
  const t = String(helpText || '');
  if (!t.includes('--tgtCcy') || !t.includes('--aiBuilderCode')) return refusal('help', 'this okx CLI cannot size a buy in USDT or tag it for the AI Builder Program. Nothing was sent.');
  return null;
}

export function gCode(code) {
  if (code === '' || code === undefined || code === null) return refusal('code', 'this copy of AvgKeeper carries no AI Builder Code from OKX yet, so it buys nothing until an update that carries one. Nothing is wrong with your account or your numbers.');
  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return refusal('code', 'this copy of AvgKeeper carries an AI Builder Code in a form OKX does not issue. Reinstall AvgKeeper.');
  return null;
}

export function resolveSite(profiles, profile) {
  const prof = profiles && typeof profiles === 'object' && Object.hasOwn(profiles, profile) ? profiles[profile] : null;
  if (!prof || typeof prof !== 'object') return null;
  const site = String(prof.site || '').trim() || 'global';
  if (site !== 'global') return site;
  const host = String(prof.base_url || '').trim() || 'https://www.okx.com';
  return /^https:\/\/www\.okx\.com\/?$/.test(host) ? 'global' : host;
}

export function gSite(profile, site) {
  // Finding 14 of the 2026-09-27 release-readiness review: a REFUSED line is a finished answer (SKILL.md rule 6), so
  // this one names the next step, which the user takes (SKILL.md First run, step 0).
  if (site == null) return refusal('site', `profile ${profile} is not in the okx config. ${CONFIG_INIT_HINT}`);
  if (site !== 'global') return refusal('site', `profile ${profile} is not on OKX Global. AvgKeeper runs on OKX Global only.`);
  return null;
}

// Item 5 of the 2026-09-27 release audit: the okx CLI's own auth helper (okx-auth, run as a child process to read
// the saved key) can fail to spawn or run for a profile that config show lists but whose key material it cannot
// actually read, a different failure from a profile absent from config entirely (gSite above catches that one
// first, from config show alone, before any call that could throw this). runner.mjs's classify() already reads the
// literal substring "okx-auth" in stderr as an auth failure; this names that one case in the user's own words
// instead of the generic "OKX did not accept API key" line, which reads as OKX rejecting a key that in fact was
// never there to read.
// Later item L6 of the 2026-09-27 release-readiness review: okx CLI 1.4.6 (dist/index.js, applyAuth) fails a profile
// with no key saved, once okx-auth is installed but not logged in, with "Error: No credentials found." instead.
// okxMessage strips the CLI's own "Error: " so the pattern reads the message itself.
export const isNoKeySavedFailure = (e) => Boolean(e) && e.kind === 'auth'
  && (/okx-auth/i.test(String(e.message || '')) || /^No credentials found/.test(okxMessage(e.message)));
// What to do about a profile or a key the okx CLI does not have: the user runs okx config init, never an agent
// (SKILL.md, First run step 0). One sentence for every refusal that needs it (rule 3).
export const CONFIG_INIT_HINT = 'Run okx config init yourself, in your own Terminal; references/api-key-setup.md in the AvgKeeper skill folder walks through it.';
export const noKeySavedLine = (profile) => `the okx CLI has no key saved for profile ${profile}. ${CONFIG_INIT_HINT}`;

// The key's own account/config row: its permissions and the IPs bound to it. One reader for preflight and holdings
// (rule 3, one fact one reader). ip is a string only: a missing or non-string field stays null (unread), never the
// empty string noIpBound reads as "confirmed no IP bound".
export async function readKeyConfig(ctx, call) {
  const acct = await ctx.okx.json(['account', 'config'], call);
  const row = Array.isArray(acct.data) ? acct.data[0] || {} : {};
  return { perm: row.perm, ip: typeof row.ip === 'string' ? row.ip : null };
}

const permList = (perm) => perm.split(',').map((p) => p.trim());

export function gWithdraw(profile, perm) {
  if (typeof perm !== 'string' || !perm.trim()) return refusal('withdraw', `AvgKeeper could not read API key ${profile}'s permissions from OKX. Try again in a moment. On the OKX website the key needs Read and Trade on, Withdraw off.`);
  if (permList(perm).includes('withdraw')) return refusal('withdraw', `API key ${profile} can withdraw. Create a key with Read and Trade only.`);
  return null;
}

// Finding 13 of the 2026-09-27 release-readiness review: a key without Trade (OKX's perm "read_only") passed every
// check, the card, confirm, doctor and smoke, and first failed at the first scheduled spot place, unattended. An
// unreadable perm is gWithdraw's own refusal above, never a second one here.
export function gTrade(profile, perm) {
  if (typeof perm !== 'string' || !perm.trim()) return null;
  if (!permList(perm).includes('trade')) return refusal('trade', `API key ${profile} cannot trade. Turn on Trade for it on the OKX website, with Withdraw still off.`);
  return null;
}

// Both key permission checks, in one list, for preflight and holdings.
export const keyPermRefusals = (profile, perm) => [gWithdraw(profile, perm), gTrade(profile, perm)].filter(Boolean);

// Item 6 of the 2026-09-27 release audit, verified against OKX's own help center (www.okx.com/en-us/help/api-faq,
// "Will the API key expire?", read 2026-09-27): "API keys that aren't bound to IP and have transaction or
// withdrawal permissions will be automatically deleted after 14 days of inactivity." AvgKeeper's own key always
// carries trade permission (gWithdraw above refuses one that can withdraw), so this applies to every AvgKeeper key
// with no IP bound.
export const OKX_KEY_INACTIVITY_DAYS = 14;
// That rule, with its citation, in one sentence: the plan card and doctor warning below and buy's auth halt both read
// it, so the wording or the source cannot be edited apart (later item L5 of the 2026-09-27 release-readiness review).
export const OKX_KEY_RULE = `OKX deletes an API key that has trade permission and no IP address bound to it after ${OKX_KEY_INACTIVITY_DAYS} days with no call to it (okx.com/en-us/help/api-faq, "Will the API key expire?").`;

// account/config's own "ip" field (www.okx.com/docs-v5/en/, Get account configuration, read 2026-09-27): "IP
// addresses that linked with current API key, ... It is an empty string "" if there is no IP bonded." True only on
// that literal empty string: a missing or unreadable field is not evidence either way, so it never warns (never
// invent a fact the code did not check).
export const noIpBound = (ip) => ip === '';

// The warning for a plan whose own cadence can leave this account's key quiet for OKX's whole inactivity window
// (above), when the key has no IP bound: one reader for the plan card and doctor (rule 3, one fact one reader). null
// when the key has an IP, or the cadence never leaves a gap that long. >=, not >: finding 5 of the 2026-09-27
// release-readiness review. A days:14 plan's two private calls land 14 days plus run jitter apart (the CLI checks
// first, an hour more across a DST fall-back, hours after a launchd catch-up), which crosses the 14 days.
export function keyInactivityWarning(ip, cadence) {
  if (!noIpBound(ip)) return null;
  const gap = maxGapDays(cadence);
  if (!(gap >= OKX_KEY_INACTIVITY_DAYS)) return null;
  return `WARNING: this API key has no IP address bound to it. ${OKX_KEY_RULE} This plan's own cadence can leave OKX untouched that long between buys. Bind an IP to the key on the OKX website, or a later buy can fail with an auth error.`;
}

// buy moves money with no word typed in the same session, so it runs only from the user's own schedule.
export function gHandRun(env, dryRun) {
  if (dryRun || (env && env.AVGKEEPER_SCHEDULED === '1')) return null;
  return refusal('hand-run', 'buy runs only from your own schedule. Ask for status to see what was bought.');
}

export function gPlanScheduled(env) {
  if (env && env.AVGKEEPER_SCHEDULED === '1') return refusal('scheduled', 'a scheduled run cannot start a plan. A plan needs you and the word AVGPLAN.');
  return null;
}

// A ledger written by a newer AvgKeeper copy may hold line kinds this copy cannot read, so this copy sends nothing on it.
// home: the store's own home (ctx.store.home), so the folder named is the one this run actually used, never a
// hard-coded ~/.avgkeeper when AVGKEEPER_HOME points elsewhere (review finding, planview.mjs:77).
export function gSchema(ledger, home) {
  const v = ledgerSchema(ledger);
  if (!(v <= LEDGER_SCHEMA)) return refusal('schema', `a newer AvgKeeper already wrote to ${displayHomePath(home)}, so this copy buys nothing. Update this copy of the skill.`);
  return null;
}

export async function preflight(ctx, call) {
  const schemaRefusal = gSchema(ctx.store.readLedger(), ctx.store.home);
  const ver = await ctx.okx.raw(['--version']);
  const help = await ctx.okx.raw(['spot', 'place', '--help']);
  const shown = await ctx.okx.json(['config', 'show']);
  const site = resolveSite((shown.data || {}).profiles, call.profile);
  const ownerTest = isOwnerTest(ctx.env);
  const siteRefusal = gSite(call.profile, site);
  const key = siteRefusal ? { perm: undefined, ip: null } : await readKeyConfig(ctx, call);
  const { ip } = key;
  const refusals = [
    schemaRefusal,
    gCliVersion(ver.out),
    gHelpFlags(`${help.out}${help.err}`),
    ownerTest ? null : gCode(BUILDER_CODE),
    siteRefusal,
    ...(siteRefusal ? [] : keyPermRefusals(call.profile, key.perm)),
  ].filter(Boolean);
  return {
    refusals, ownerTest, ip,
  };
}
