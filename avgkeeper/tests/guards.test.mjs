// avgkeeper/tests/guards.test.mjs
import {
  makeCtx, fakeExchange, OWNER, SCHEDULED, CALL, LOSING, T0, HOUR, text, places,
} from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUILDER_CODE, gCliVersion, gHelpFlags, gCode, gSite, gWithdraw, gTrade, gHandRun, gPlanScheduled, gSchema, preflight, PROFILE_NAME,
  builderDisclosure, setBuilderCodeForTest, noIpBound, keyInactivityWarning, OKX_KEY_INACTIVITY_DAYS, OKX_KEY_RULE,
  failureLine, CONFIG_INIT_HINT, resolveSite,
} from '../scripts/guards.mjs';
import { planVerb } from '../scripts/plan.mjs';
import { buyVerb } from '../scripts/buy.mjs';
import { doctorVerb } from '../scripts/schedule.mjs';
import { OkxError } from '../scripts/runner.mjs';

test('the Builder Code is empty until OKX issues one', () => {
  assert.equal(BUILDER_CODE, '');
  assert.equal(gCode('').guard, 'code');
  assert.equal(gCode('abc123'), null);
});

test('CLI version floor and help flags', () => {
  assert.equal(gCliVersion('1.4.6'), null);
  assert.equal(gCliVersion('1.4.3').guard, 'cli');
  assert.equal(gCliVersion('').guard, 'cli');
  assert.equal(gHelpFlags('--tgtCcy --aiBuilderCode'), null);
  assert.equal(gHelpFlags('--tgtCcy').guard, 'help');
});

test('site and withdraw permission', () => {
  assert.equal(gSite('t', 'global'), null);
  assert.equal(gSite('t', null).guard, 'site');
  assert.equal(gSite('t', 'eea').guard, 'site');
  assert.equal(gWithdraw('t', 'read_only,trade'), null);
  assert.equal(gWithdraw('t', 'read_only,trade,withdraw').guard, 'withdraw');
  assert.equal(gWithdraw('t', undefined).guard, 'withdraw');
});

// Review finding (guards.mjs:77): resolveSite is the only guard that keeps a profile saved for another OKX site
// or another host off the OKX Global path (preflight refuses via gSite before any private call reaches it), and it
// had no test of its own at all.
test('resolveSite reads a profile\'s own site and base_url, and a missing profile as null', () => {
  assert.equal(resolveSite({ t: { site: 'eea' } }, 't'), 'eea');
  assert.equal(resolveSite({ t: { base_url: 'https://proxy.example' } }, 't'), 'https://proxy.example');
  assert.equal(resolveSite({ t: {} }, 't'), 'global');
  assert.equal(resolveSite({ t: { base_url: 'https://www.okx.com/' } }, 't'), 'global');
  assert.equal(resolveSite({ t: { base_url: 'https://www.okx.com' } }, 't'), 'global');
  assert.equal(resolveSite({}, 't'), null);
  assert.equal(resolveSite(null, 't'), null);
  assert.equal(resolveSite({ t: null }, 't'), null);
});

// A profile saved for OKX EEA (site 'eea', not 'global') must refuse preflight the same way a missing profile
// does, not silently pass as OKX Global.
test('preflight refuses a profile saved for another OKX site, not OKX Global', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange({ ...LOSING, site: 'eea' }) });
  const r = await preflight(ctx, CALL);
  assert.equal(r.refusals[0].guard, 'site');
  assert.match(r.refusals[0].msg, /not on OKX Global/);
});

test('buy runs only from the schedule, a plan never does', () => {
  assert.equal(gHandRun({}, false).guard, 'hand-run');
  assert.equal(gHandRun({}, true), null);
  assert.equal(gHandRun({ AVGKEEPER_SCHEDULED: '1' }, false), null);
  assert.equal(gPlanScheduled({ AVGKEEPER_SCHEDULED: '1' }).guard, 'scheduled');
  assert.equal(gPlanScheduled({}), null);
});

test('gSchema passes on an empty or current-schema ledger and refuses on a newer one', () => {
  assert.equal(gSchema([]), null);
  assert.equal(gSchema([{ v: 1 }]), null);
  assert.equal(gSchema([{ v: 2 }]).guard, 'schema');
  assert.equal(gSchema([{ v: 'x' }]).guard, 'schema');
});

test('preflight passes in owner test mode and refuses without a code otherwise', async () => {
  const ok = await preflight(makeCtx({ env: OWNER }), CALL);
  assert.deepEqual(ok.refusals, []);
  assert.equal(ok.ownerTest, true);
  const noCode = await preflight(makeCtx(), CALL);
  assert.deepEqual(noCode.refusals.map((r) => r.guard), ['code']);
  const bad = await preflight(makeCtx({ env: OWNER, okx: fakeExchange({ perm: 'read_only,trade,withdraw' }) }), CALL);
  assert.deepEqual(bad.refusals.map((r) => r.guard), ['withdraw']);
});

// Finding 13 of the 2026-09-27 release-readiness review: a key without Trade (perm "read_only") passed every check,
// the card, confirm, doctor and smoke, and first failed at the first scheduled spot place, unattended.
test('a key that cannot trade is refused by preflight, in plain words', async () => {
  assert.equal(gTrade('t', 'read_only,trade'), null);
  assert.equal(gTrade('t', 'read_only').msg, 'REFUSED: API key t cannot trade. Turn on Trade for it on the OKX website, with Withdraw still off.');
  assert.equal(gTrade('t', undefined), null, 'an unreadable permission is gWithdraw\'s own refusal, never a second one');
  const readOnly = await preflight(makeCtx({ env: OWNER, okx: fakeExchange({ perm: 'read_only' }) }), CALL);
  assert.deepEqual(readOnly.refusals.map((r) => r.guard), ['trade']);
  const both = await preflight(makeCtx({ env: OWNER, okx: fakeExchange({ perm: 'read_only,withdraw' }) }), CALL);
  assert.deepEqual(both.refusals.map((r) => r.guard), ['withdraw', 'trade']);
});

test('a plan card refuses a key that cannot trade', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange({ ...LOSING, perm: 'read_only' }), now: T0 - 2 * HOUR });
  assert.equal(await planVerb(ctx, {
    profile: 't', budget: '10', every: 'day', method: 'equal',
  }), 1);
  assert.match(text(ctx), /REFUSED: API key t cannot trade\./);
  assert.ok(!text(ctx).includes('type AVGPLAN'), text(ctx));
});

test('preflight refuses first on a ledger a newer AvgKeeper already wrote to', async () => {
  const ctx = makeCtx({ env: OWNER });
  fs.mkdirSync(ctx.store.home, { recursive: true });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), `${JSON.stringify({ kind: 'plan_card', v: 2 })}\n`);
  const r = await preflight(ctx, CALL);
  assert.deepEqual(r.refusals.map((x) => x.guard), ['schema']);
});

test('profile names are plain words', () => {
  assert.ok(PROFILE_NAME.test('mydemo'));
  assert.ok(!PROFILE_NAME.test('a b'));
});

// Item 4 of the 2026-09-27 release audit: the three disclosure sentences, and the one seam a test may use to
// prove the "a code is set" state without ever editing this file.
test('builderDisclosure names the three states, owner test always winning over a code that is set', () => {
  assert.equal(builderDisclosure(true), 'OWNER TEST: no code is sent, so nothing is attributed.');
  assert.equal(builderDisclosure(false), 'This copy of AvgKeeper carries no code yet, so it buys nothing.');
});

test('setBuilderCodeForTest refuses outside a test process', () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.throws(() => setBuilderCodeForTest('abc123'), /for tests only/);
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('once a code is set, orders carry --aiBuilderCode and the disclosure says so, outside owner test mode', async () => {
  assert.equal(BUILDER_CODE, '');
  setBuilderCodeForTest('abcXYZ123');
  try {
    assert.equal(builderDisclosure(false), "Orders carry OKX's AI Builder Code.");
    const okx = fakeExchange(LOSING);
    const ctx = makeCtx({ okx, now: T0 - 2 * HOUR });
    const flags = {
      profile: 't', budget: '10', every: 'day', method: 'weighted', only: 'ETH',
    };
    assert.equal(await planVerb(ctx, flags), 0);
    assert.ok(text(ctx).includes("Orders carry OKX's AI Builder Code."), text(ctx));
    // Finding 9 of the 2026-09-27 release-readiness review: text(ctx) is cumulative, so the card's own line used to
    // satisfy this for the receipt too. Only what the confirm itself printed counts here.
    const cardLines = ctx.lines.length;
    assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 0);
    assert.ok(ctx.lines.slice(cardLines).includes("Orders carry OKX's AI Builder Code."), ctx.lines.slice(cardLines).join('\n'));
    ctx.env = { AVGKEEPER_SCHEDULED: '1' };
    ctx.setNow(T0);
    assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
    const sent = places(okx);
    assert.equal(sent.length, 1);
    const codeIdx = sent[0].args.indexOf('--aiBuilderCode');
    assert.ok(codeIdx > -1, sent[0].args.join(' '));
    assert.equal(sent[0].args[codeIdx + 1], 'abcXYZ123');
  } finally {
    setBuilderCodeForTest('');
  }
});

// Review finding (buy.mjs:368): owner test mode sending no code was untested once BUILDER_CODE was actually set;
// every other test left it at its real, empty default, so a mutant that sent the code under owner test mode too
// would still pass. buyPeriod's own owner-test branch (`pre.ownerTest ? '' : BUILDER_CODE`) must win over a set code.
test('owner test mode sends no code even once BUILDER_CODE is set', async () => {
  setBuilderCodeForTest('abcXYZ123');
  try {
    const okx = fakeExchange(LOSING);
    const ctx = makeCtx({
      okx, env: OWNER, now: T0 - 2 * HOUR,
    });
    const flags = {
      profile: 't', budget: '10', every: 'day', method: 'weighted', only: 'ETH',
    };
    await planVerb(ctx, flags);
    await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
    ctx.env = SCHEDULED;
    ctx.setNow(T0);
    assert.equal(await buyVerb(ctx, { profile: 't' }), 0);
    const sent = places(okx);
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].args.includes('--aiBuilderCode'), sent[0].args.join(' '));
  } finally {
    setBuilderCodeForTest('');
  }
});

// Finding 9 of the 2026-09-27 release-readiness review: the receipt's and doctor's own disclosure lines could be
// deleted with every test green. Each surface is checked on its own output.
test('the receipt prints the owner test disclosure itself, not only the card before it', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * HOUR });
  const flags = {
    profile: 't', budget: '10', every: 'day', method: 'equal',
  };
  assert.equal(await planVerb(ctx, flags), 0);
  ctx.lines.length = 0;
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 0);
  assert.ok(ctx.lines.includes('OWNER TEST: no code is sent, so nothing is attributed.'), text(ctx));
});

test('doctor prints the disclosure for owner test mode and for a copy with no code', async () => {
  const owner = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await doctorVerb(owner, { profile: 't' });
  assert.ok(owner.lines.includes('OWNER TEST: no code is sent, so nothing is attributed.'), text(owner));
  const noCode = makeCtx({ okx: fakeExchange(LOSING) });
  assert.equal(await doctorVerb(noCode, { profile: 't' }), 1);
  assert.ok(noCode.lines.includes('This copy of AvgKeeper carries no code yet, so it buys nothing.'), text(noCode));
});

// Item 6 of the 2026-09-27 release audit: OKX deletes a trade key with no IP bound after 14 days of inactivity
// (verified against www.okx.com/en-us/help/api-faq, "Will the API key expire?"). noIpBound and keyInactivityWarning
// are the one reader the plan card and doctor both call.
test('noIpBound reads only the literal empty string, never a missing or unreadable field as evidence', () => {
  assert.equal(noIpBound(''), true);
  assert.equal(noIpBound('117.37.203.58'), false);
  assert.equal(noIpBound(null), false);
  assert.equal(noIpBound(undefined), false);
});

// Finding 5 of the 2026-09-27 release-readiness review: a days:14 plan's two private calls land 14 days plus run
// jitter apart (seconds of CLI checks first, an hour more across a DST fall-back, hours after a launchd catch-up),
// which crosses OKX's 14 days of inactivity. The boundary warns; 13 days does not.
test('keyInactivityWarning fires only with no IP bound and a cadence that can leave a gap of 14 days or more', () => {
  assert.equal(OKX_KEY_INACTIVITY_DAYS, 14);
  assert.equal(keyInactivityWarning('1.2.3.4', { kind: 'days', n: 20 }), null, 'an IP is bound: never warns');
  assert.equal(keyInactivityWarning('', { kind: 'day' }), null, 'daily never leaves a 14-day gap');
  assert.equal(keyInactivityWarning('', { kind: 'days', n: 13 }), null, '13 days plus jitter stays under 14');
  assert.match(keyInactivityWarning('', { kind: 'days', n: 14 }), /no IP address bound/, 'exactly 14 plus any jitter crosses 14 days');
  assert.match(keyInactivityWarning('', { kind: 'days', n: 20 }), /no IP address bound.*14 days.*okx\.com\/en-us\/help\/api-faq/s);
  assert.match(keyInactivityWarning('', { kind: 'month', day: 1 }), /no IP address bound/, 'a month always exceeds 14 days, even its shortest');
  assert.equal(keyInactivityWarning(null, { kind: 'days', n: 20 }), null, 'an unread ip field is not evidence either way');
});

// Later item L5 of the 2026-09-27 release-readiness review: OKX's key rule, with its citation, has one author. The
// plan card and doctor warning and the auth halt both read it (rule 3, one fact one reader).
test('the OKX key rule sentence is one constant, read by the inactivity warning', () => {
  assert.equal(OKX_KEY_RULE, 'OKX deletes an API key that has trade permission and no IP address bound to it after 14 days with no call to it (okx.com/en-us/help/api-faq, "Will the API key expire?").');
  assert.ok(keyInactivityWarning('', { kind: 'days', n: 20 }).includes(OKX_KEY_RULE));
});

// Review findings (buy.mjs:145, guards.mjs:44, probe K1): a profile with no key saved locally ("Error: No
// credentials found.") is not OKX rejecting a key it never saw. failureLine (plan, doctor) must word it the way
// holdings already does, never as "OKX did not accept" and never with OKX's 14-day deletion rule, which assumes a
// key OKX actually saw.
test('failureLine words a missing saved key as missing, never as OKX rejecting it or the 14-day rule', () => {
  const noKey = new OkxError('Error: No credentials found.', 'auth', 'Error: No credentials found.');
  assert.equal(failureLine(noKey, 't'), `REFUSED: the okx CLI has no key saved for profile t. ${CONFIG_INIT_HINT}`);
  const rejected = new OkxError('Error: Invalid OK-ACCESS-KEY', 'auth', 'Error: Invalid OK-ACCESS-KEY');
  assert.doesNotMatch(failureLine(rejected, 't'), /No credentials found|has no key saved/);
  assert.match(failureLine(rejected, 't'), /^OKX did not accept API key t \(Invalid OK-ACCESS-KEY\)\./);
});
