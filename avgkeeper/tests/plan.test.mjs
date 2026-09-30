// avgkeeper/tests/plan.test.mjs
import {
  makeCtx, fakeExchange, LOSING, OWNER, CALL, T0, HOUR, DAY, text, kinds,
} from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  planVerb, readPlanFlags, planId, isConfirmWord, CONFIRM_WORD,
} from '../scripts/plan.mjs';
import { activePlan } from '../scripts/planview.mjs';
import { monthlyUsdt } from '../scripts/cards.mjs';
import { buyClOrdId } from '../scripts/orders.mjs';
import { lastRunLine } from '../scripts/period.mjs';

const flags = { profile: 't', budget: '10', every: 'day', method: 'weighted' };

test('readPlanFlags asks for what is missing and refuses what is wrong', () => {
  assert.equal(readPlanFlags({}).errors.length, 3);
  assert.match(readPlanFlags({ ...flags, budget: '0.5' }).errors[0], /at least 1/);
  assert.match(readPlanFlags({ ...flags, every: 'weekly' }).errors[0], /--every reads weekly/);
  assert.match(readPlanFlags({ ...flags, only: 'BTC', exclude: 'ETH' }).errors[0], /not both/);
  assert.deepEqual(readPlanFlags({ ...flags, exclude: 'eth, btc' }).fields.exclude, ['BTC', 'ETH']);
  assert.equal(readPlanFlags(flags).fields.at, '10:00');
  assert.equal(readPlanFlags(flags).fields.dust, '10.00');
});

// Section 10: --every hour, and --at's two shapes, each refused for the wrong cadence with the right form named.
test('readPlanFlags: an hourly plan defaults --at to :05 and refuses HH:MM', () => {
  const hourly = { profile: 't', budget: '10', every: 'hour', method: 'equal' };
  assert.equal(readPlanFlags(hourly).fields.cadence, 'hour');
  assert.equal(readPlanFlags(hourly).fields.at, ':05');
  assert.equal(readPlanFlags({ ...hourly, at: ':30' }).fields.at, ':30');
  assert.match(readPlanFlags({ ...hourly, at: '10:00' }).errors[0], /--at for an hourly plan is the minute past the hour, like :05; it reads 10:00\./);
});

test('readPlanFlags: :MM is refused for every cadence but hour', () => {
  assert.match(readPlanFlags({ ...flags, at: ':05' }).errors[0], /--at must be a time like 10:00; it reads :05\./);
});

// --at reads by cadence, so it cannot be judged while --every cannot be read: a mistyped cadence word must not also
// be told that a correct hourly :MM is the wrong shape. The --every refusal alone names the fix.
test('readPlanFlags: an unreadable --every refuses only --every, never --at', () => {
  const errors = readPlanFlags({ ...flags, every: 'hours', at: ':05' }).errors;
  assert.equal(errors.length, 1, errors.join(' | '));
  assert.match(errors[0], /^--every reads hours; use hour, day/);
});

test("step 1 prints the card with today's split and writes a plan_card", async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await planVerb(ctx, flags), 0);
  const t = text(ctx);
  assert.match(t, /10\.00 USDT every day at 10:00 \(Europe\/Istanbul\), split by loss size/);
  assert.match(t, /ETH\s+-10\.00%\s+6\.67 USDT/);
  assert.match(t, /BTC\s+-5\.00%\s+3\.33 USDT/);
  assert.match(t, /SOL \(in profit\)/);
  assert.match(t, /about 300\.00 USDT a month/);
  assert.match(t, /Every buy spends free USDT, so less is left for anything else you run on this account\./);
  assert.doesNotMatch(t, /GridKeeper/);
  assert.match(t, /raises that coin's share/);
  assert.match(t, /type AVGPLAN/);
  assert.deepEqual(kinds(ctx), ['plan_card']);
});

// Spec section 9, "Surfaces": the card and the receipt print the same mail line, from mail.mjs's own mailLine
// (cards.test.mjs pins the card's own helper call directly).
test('the card and the receipt print the mail line matching the account config', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), config: { mail: { to: 'a@b.co', level: 'all' } } });
  assert.equal(await planVerb(ctx, flags), 0);
  assert.match(text(ctx), /^Mail: every buy with its details, to a@b\.co\.$/m);
  ctx.lines.length = 0;
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 0);
  assert.match(text(ctx), /^Mail: every buy with its details, to a@b\.co\.$/m);
});

test('the card and the receipt say Mail: off. when nothing is configured', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await planVerb(ctx, flags), 0);
  assert.match(text(ctx), /^Mail: off\.$/m);
  ctx.lines.length = 0;
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 0);
  assert.match(text(ctx), /^Mail: off\.$/m);
});

// Review finding (plan.mjs:132/205, later): status already prints readConfigSafe's own `line` as a WARNING
// (commit 6a9d2e7); the card and the receipt still discarded it and printed a bare "Mail: off." for a user who
// in fact set mail to all, the same gap notify.mjs:59 already closed for status.
test('the card and the receipt print the config problem, never a bare "Mail: off." with no reason', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), config: { mail: { to: 'a@b.co', level: 'all', command: 'cat' } } });
  fs.writeFileSync(path.join(ctx.store.home, 'config.json'), '{nope');
  assert.equal(await planVerb(ctx, flags), 0);
  let t = text(ctx);
  assert.match(t, /WARNING: config\.json is not valid JSON .*notify and mail are both off until it is fixed\./, t);
  assert.match(t, /^Mail: off\.$/m, t);
  ctx.lines.length = 0;
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 0);
  t = text(ctx);
  assert.match(t, /WARNING: config\.json is not valid JSON .*notify and mail are both off until it is fixed\./, t);
  assert.match(t, /^Mail: off\.$/m, t);
});

test('step 2 needs the card of step 1, within 30 minutes', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 1);
  assert.match(text(ctx), /show the plan card first/);
  await planVerb(ctx, flags);
  ctx.setNow(T0 + HOUR);
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 1);
  ctx.setNow(T0 + 2 * HOUR);
  await planVerb(ctx, flags);
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 0);
  const plan = activePlan(ctx.store.readLedger(), CALL);
  assert.equal(plan.budget, '10.00');
  assert.equal(plan.anchorDate, '2026-10-05');
  assert.equal(plan.activeFrom, '2026-10-05 12:00');
});

test('a wrong confirm word is refused', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'yes' }), 1);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null);
});

// 2026-09-28: a phone keyboard capitalizes the first letter, so a user who typed AVGPLAN on their phone got
// Avgplan. isConfirmWord (and confirm through it) accepts the word in any letter case and nothing else: SKILL.md
// rule 2 loosens only letter case, so whitespace before or after the word, other words, punctuation, a near
// miss, a look-alike letter from another alphabet, a fullwidth letter and a zero-width character inside the word
// all stay refused (2026-09-28 review: an earlier version also stripped surrounding whitespace, which nothing in
// rule 2 asked for).
test('isConfirmWord accepts the word in any letter case, and nothing else', () => {
  for (const word of [CONFIRM_WORD, 'Avgplan', 'avgplan', 'AvGpLaN']) {
    assert.equal(isConfirmWord(word), true, word);
  }
});

test('isConfirmWord refuses whitespace, extra words, punctuation, a near miss, a look-alike letter, empty and non-strings', () => {
  for (const word of [
    'AVGPLAN please', 'ok AVGPLAN', 'AVGPLAN?', 'AVGPLAN.', 'AVGPLN', '', ' ', undefined, null, 123,
    '  AVGPLAN  ', '\tAVGPLAN\n', '﻿AVGPLAN',
    'AVG PLAN', 'Avg plan', 'AVG\nPLAN',
    'АVGPLAN', // Cyrillic capital А (U+0410), reads identically to Latin A
    'ＡＶＧＰＬＡＮ', // fullwidth AVGPLAN
    'AVG​PLAN', // zero-width space (U+200B) inside the word
  ]) {
    assert.equal(isConfirmWord(word), false, String(word));
  }
});

test('confirm accepts AVGPLAN in any letter case, and nothing else', async () => {
  for (const word of [CONFIRM_WORD, 'Avgplan', 'avgplan']) {
    const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
    await planVerb(ctx, flags);
    assert.equal(await planVerb(ctx, { ...flags, confirm: word }), 0, word);
    assert.ok(activePlan(ctx.store.readLedger(), CALL), word);
  }
});

test('confirm refuses whitespace, extra words, punctuation, a near miss, a look-alike letter and an empty confirm', async () => {
  for (const word of [
    'AVGPLAN please', 'ok AVGPLAN', 'AVGPLAN?', 'AVGPLAN.', 'AVGPLN', '',
    '  AVGPLAN  ', '\tAVGPLAN\n', '﻿AVGPLAN',
    'AVG PLAN', 'Avg plan', 'AVG\nPLAN',
    'АVGPLAN',
    'ＡＶＧＰＬＡＮ',
    'AVG​PLAN',
  ]) {
    const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
    await planVerb(ctx, flags);
    assert.equal(await planVerb(ctx, { ...flags, confirm: word }), 1, word);
    assert.match(text(ctx), /the word that starts a plan is AVGPLAN/);
    assert.equal(activePlan(ctx.store.readLedger(), CALL), null, word);
  }
});

test('a new plan replaces the running one', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const first = activePlan(ctx.store.readLedger(), CALL).id;
  const next = { ...flags, method: 'equal' };
  await planVerb(ctx, next);
  await planVerb(ctx, { ...next, confirm: 'AVGPLAN' });
  const plan = activePlan(ctx.store.readLedger(), CALL);
  assert.notEqual(plan.id, first);
  assert.equal(plan.method, 'equal');
  assert.ok(kinds(ctx).includes('plan_stopped'));
});

// Item 4 of the 2026-09-26 review: the card names the plan it would replace, above the AVGPLAN line, only when
// one is running and it differs from the card being shown.
test('the plan card names the running plan it would replace', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const running = activePlan(ctx.store.readLedger(), CALL);
  ctx.lines.length = 0;
  await planVerb(ctx, { ...flags, method: 'equal' });
  const t = text(ctx);
  assert.match(t, new RegExp(`This replaces the running plan ${running.id} \\(10\\.00 USDT every day at 10:00 \\(Europe/Istanbul\\), split by loss size\\)`));
  const idx = t.indexOf('This replaces the running plan');
  assert.ok(idx > -1 && idx < t.indexOf('To start it, type AVGPLAN'));
});

// Review finding (manage.mjs:81, rule 4): a halted plan buys nothing; the card must say it would replace the
// halted plan, not "the running plan", which claims the opposite of what haltedLine already says elsewhere.
test('the plan card names a halted plan it would replace as halted, not running', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const running = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: running.id, profile: 't', env: 'live', reason: 'OKX did not accept API key t.' }, T0);
  ctx.lines.length = 0;
  await planVerb(ctx, { ...flags, method: 'equal' });
  const t = text(ctx);
  assert.match(t, new RegExp(`This replaces the halted plan ${running.id} \\(`));
  assert.doesNotMatch(t, /This replaces the running plan/);
});

test('the plan card names nothing to replace when no plan runs, or the card matches the running plan', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  assert.doesNotMatch(text(ctx), /This replaces the running plan/);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  await planVerb(ctx, flags);
  assert.doesNotMatch(text(ctx), /This replaces the running plan/);
});

// Review finding (cards.mjs:163, should): a card with the same settings as a HALTED plan on record (same id) said
// nothing about the halt at all, and the receipt then said "It replaces plan <its own id>." The spec says a halt
// lasts "until the user checks status and restarts"; the card must say confirming it restarts that halted plan.
test('a card matching a halted plan\'s own settings names the halt and says it restarts it', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const running = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: running.id, profile: 't', env: 'live', reason: 'OKX did not accept API key t.' }, T0);
  ctx.lines.length = 0;
  await planVerb(ctx, flags);
  const t = text(ctx);
  assert.match(t, /This restarts the halted plan: OKX did not accept API key t\./, t);
  assert.doesNotMatch(t, /This replaces/);
});

// Review findings (cards.mjs:163, should and later; manage.mjs:201, paths lens): confirming a card with the same
// settings as the running plan (same id) used to say "It replaces plan <its own id>." and silently re-anchor an
// every-N-days cadence's own future buy days with no word to the user.
test('the receipt never says a plan replaces itself, and names an every-N-days re-anchor that actually moves a buy', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * DAY });
  const daysFlags = { profile: 't', budget: '10', every: 'days:3', method: 'weighted' };
  await planVerb(ctx, daysFlags);
  await planVerb(ctx, { ...daysFlags, confirm: 'AVGPLAN' });
  const first = activePlan(ctx.store.readLedger(), CALL);
  // Anchored 2026-10-03, so the old schedule's own next buy day is 2026-10-06 (diff 3, 3 % 3 === 0); re-confirming
  // on 2026-10-05, not itself an old buy day, actually pulls that next buy a day earlier.
  ctx.setNow(T0);
  ctx.lines.length = 0;
  await planVerb(ctx, daysFlags);
  await planVerb(ctx, { ...daysFlags, confirm: 'AVGPLAN' });
  const t = text(ctx);
  assert.doesNotMatch(t, /It replaces plan/);
  assert.match(t, /This restarts the plan; it does not replace a different one\. Its every-N-days count restarts from today \(2026-10-05\), so its next buy moves from 2026-10-06 to today\./);
  const second = activePlan(ctx.store.readLedger(), CALL);
  assert.equal(second.id, first.id);
  assert.notEqual(second.anchorDate, first.anchorDate);
});

// Review finding (cards.mjs, later): the old code named a shift unconditionally for every days:N restart, even on
// a day the old schedule already had planned as a buy day, where re-anchoring changes nothing at all (rule 2,
// never state a cause that did not happen).
test('the receipt names no shift when today was already the old schedule\'s own next buy day', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * DAY });
  const daysFlags = { profile: 't', budget: '10', every: 'days:3', method: 'weighted' };
  await planVerb(ctx, daysFlags);
  await planVerb(ctx, { ...daysFlags, confirm: 'AVGPLAN' });
  // Anchored 2026-10-03; 2026-10-06 (T0 + DAY) is itself an old buy day (diff 3, 3 % 3 === 0), so re-anchoring
  // there moves nothing.
  ctx.setNow(T0 + DAY);
  ctx.lines.length = 0;
  await planVerb(ctx, daysFlags);
  await planVerb(ctx, { ...daysFlags, confirm: 'AVGPLAN' });
  const t = text(ctx);
  assert.match(t, /This restarts the plan; it does not replace a different one\.$/m, t);
  assert.doesNotMatch(t, /future buy days shift|next buy moves/, t);
});

// Review finding (cards.mjs, later): a restarted HALTED days:N plan re-anchors its every-N-days count exactly the
// same way a healthy same-id restart does, but neither the card nor the receipt ever named the shift for it.
test('a restarted halted plan\'s receipt also names an every-N-days re-anchor that actually moves a buy', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * DAY });
  const daysFlags = { profile: 't', budget: '10', every: 'days:3', method: 'weighted' };
  await planVerb(ctx, daysFlags);
  await planVerb(ctx, { ...daysFlags, confirm: 'AVGPLAN' });
  const halted = activePlan(ctx.store.readLedger(), CALL);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: halted.id, profile: 't', env: 'live', reason: 'test halt' }, T0 - HOUR);
  ctx.setNow(T0);
  ctx.lines.length = 0;
  await planVerb(ctx, daysFlags);
  await planVerb(ctx, { ...daysFlags, confirm: 'AVGPLAN' });
  const t = text(ctx);
  assert.match(t, /This restarts the plan that was halted; it does not replace a different one\. Its every-N-days count restarts from today \(2026-10-05\), so its next buy moves from 2026-10-06 to today\./, t);
});

// Review finding (manage.mjs:201... /cards.mjs:163 later, paths lens): a card matching the RUNNING plan's own
// settings (same id) said nothing at all, so the user typing AVGPLAN again never learned that confirm re-anchors
// an every-N-days cadence, shifting its future buy days.
test('a card matching the running plan\'s own settings says it restarts it, not that it replaces it', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  await planVerb(ctx, flags);
  const t = text(ctx);
  assert.match(t, /This is the running plan's own settings: confirming it restarts the plan, it does not start a new one\./, t);
});

// Review findings (cards.mjs:163, should and later): the card, the consent screen read BEFORE typing AVGPLAN,
// never named an every-N-days re-anchor at all; only the receipt, after consent, did. Named here too, from the
// same helper the receipt reads (rule 3, one fact one reader), so the user knows what confirming will do before
// they do it.
test('a card matching the running plan\'s own settings names an every-N-days re-anchor before AVGPLAN, when one actually moves a buy', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING), now: T0 - 2 * DAY });
  const daysFlags = { profile: 't', budget: '10', every: 'days:3', method: 'weighted' };
  await planVerb(ctx, daysFlags);
  await planVerb(ctx, { ...daysFlags, confirm: 'AVGPLAN' });
  ctx.setNow(T0);
  ctx.lines.length = 0;
  await planVerb(ctx, daysFlags);
  const t = text(ctx);
  assert.match(t, /This is the running plan's own settings: confirming it restarts the plan, it does not start a new one\. Its every-N-days count restarts from today \(2026-10-05\), so its next buy moves from 2026-10-06 to today\./, t);
  assert.match(t, /type AVGPLAN/, 'the card still ends with the confirm invitation');
});

// Review finding (manage.mjs:201, should, paths lens): a run that dies partway leaves a stale period (a coin
// filled, no period_done, no notice). Before this, confirm closed nothing about it when it replaced the plan that
// left it stale, so that money never reached a mail with its details (spec section 9).
test('confirm closes a stale period from the plan it replaces, and mails its detail line', async () => {
  const ctx = makeCtx({
    env: OWNER, okx: fakeExchange(LOSING), config: { notify: 'cat', notifyLevel: 'all', mail: { to: 'a@b.co', level: 'all', command: 'cat' } },
  });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const planId0 = activePlan(ctx.store.readLedger(), CALL).id;
  const ethId = buyClOrdId({
    planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', profile: 't', demo: false,
  });
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '5.00', lossPct: 5, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '5.00', profile: 't', env: 'live', notional: 5.0, accFillSz: '0.00283', avgPx: '1767.30',
  }, T0);
  ctx.lines.length = 0;
  await planVerb(ctx, { ...flags, method: 'equal' });
  await planVerb(ctx, { ...flags, method: 'equal', confirm: 'AVGPLAN' });
  assert.ok(kinds(ctx).includes('period_done'), kinds(ctx).join(','));
  const resolveLine = ctx.notified.find((l) => l.includes('stopped partway'));
  assert.match(resolveLine || '', /The run for 2026-10-05 stopped partway; it had recorded these orders: ETH-USDT\./);
  assert.equal(ctx.mailed.length, 1);
  assert.match(ctx.mailed[0].body, /ETH-USDT: share 5\.00 USDT/);
});

// Review finding (plan.mjs:187, with buy.mjs:351, period.mjs:216; should): confirmLocked calls
// closeStalePeriods(running) before writing the new plan_active, and closeStalePeriod's own period_done write used
// ctx.now() directly. On a same-id restart (identical settings hash to the same id, planId0 below), that closing
// period_done's ts could land no earlier than the new plan_active's own ts (the two calls read the same clock),
// so lastRun's own life filter ("< since", strict) never excluded it: the new life read as though it had already
// bought, before its own schedule ever ran.
test('a same-id confirm over a plan with a stale period never credits that period as the new life\'s own Last run', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const planId0 = activePlan(ctx.store.readLedger(), CALL).id;
  const ethId = buyClOrdId({
    planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', profile: 't', demo: false,
  });
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '5.00', lossPct: 5, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({
    kind: 'buy_filled', planId: planId0, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: ethId, amount: '5.00', profile: 't', env: 'live', notional: 5.0, accFillSz: '0.00283', avgPx: '1767.30',
  }, T0);
  ctx.setNow(T0 + HOUR);
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const plan1 = activePlan(ctx.store.readLedger(), CALL);
  assert.equal(plan1.id, planId0, 'identical settings hash to the same plan id');
  const run = lastRunLine(ctx.store.readLedger(), plan1);
  assert.doesNotMatch(run, /Last run: it bought, for 2026-10-05/, run);
  assert.match(run, /^Last run: never;/, run);
});

// Item 2 of the 2026-09-26 review: a stopped plan's open send blocks a new plan as much as the running plan's.
test('confirm refuses while a stopped plan still has a send whose result is not recorded', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const old = activePlan(ctx.store.readLedger(), CALL).id;
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: old, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'akopen1', amount: '10.00', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({ kind: 'plan_stopped', planId: old, profile: 't', env: 'live', reason: 'stopped by you' }, T0);
  const next = { ...flags, method: 'equal' };
  await planVerb(ctx, next);
  assert.equal(await planVerb(ctx, { ...next, confirm: 'AVGPLAN' }), 1);
  assert.match(text(ctx), /REFUSED: a buy on this profile has a result that is not recorded yet \(order\(s\) akopen1\)/);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null);
});

// Review finding (manage.mjs:199 area / plan.mjs:32 confirmRefusal, should): with no plan running at all (the
// owning plan already stopped), the old clue told the user to "try again after the next scheduled run reads it
// back", but no schedule will ever come: nothing is running. Run stop is what actually clears it (manage.mjs's own
// fix, once its no-plan branch also marks an orphaned send unknown).
test('confirm refuses on an orphaned send with no plan running, and says stop clears it, not the schedule', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const old = activePlan(ctx.store.readLedger(), CALL).id;
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: old, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'akopen1', amount: '10.00', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({ kind: 'plan_stopped', planId: old, profile: 't', env: 'live', reason: 'stopped by you' }, T0);
  const next = { ...flags, method: 'equal' };
  await planVerb(ctx, next);
  assert.equal(await planVerb(ctx, { ...next, confirm: 'AVGPLAN' }), 1);
  assert.match(text(ctx), /REFUSED: a buy on this profile has a result that is not recorded yet \(order\(s\) akopen1\)\. No plan is running to read it back\. Run stop to clear it\./);
  assert.doesNotMatch(text(ctx), /try again after the next scheduled run reads it back/);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null);
});

// Review finding (cards.mjs:164, later): the card ended "To start it, type AVGPLAN" although confirm is certain to
// refuse it (an unsettled send on the account). The card now states confirm's own refusal instead of inviting the
// word that is certain to be refused.
test('the card states confirm\'s own refusal instead of inviting AVGPLAN, when a send on the account is unsettled', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const old = activePlan(ctx.store.readLedger(), CALL).id;
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: old, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'akopen1', amount: '10.00', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  ctx.lines.length = 0;
  const next = { ...flags, budget: '20' };
  await planVerb(ctx, next);
  const t = text(ctx);
  assert.doesNotMatch(t, /To start it, type AVGPLAN/);
  assert.match(t, /AVGPLAN would be refused right now: a buy on this profile has a result that is not recorded yet \(order\(s\) akopen1\)\. Ask for status, and try again after the next scheduled run reads it back\./);
});

// Review finding (cards.mjs:164, later): the same applies to a torn ledger: confirm is certain to refuse until the
// line is fixed or removed.
test('the card states confirm\'s own refusal instead of inviting AVGPLAN, when the ledger is torn', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), '{"kind":"plan_active","id":\n');
  await planVerb(ctx, flags);
  const t = text(ctx);
  assert.doesNotMatch(t, /To start it, type AVGPLAN/);
  assert.match(t, /AVGPLAN would be refused right now: a plan cannot be confirmed while a ledger line cannot be read/);
});

// Review finding (cards.mjs:164, later): planLine already ends in a period; wrapped in parentheses unchanged, the
// replace line read "...split equally.)" with the period stranded before the closing paren.
test('the replace line drops planLine\'s own trailing period inside the parentheses', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  ctx.lines.length = 0;
  await planVerb(ctx, { ...flags, method: 'equal' });
  const t = text(ctx);
  assert.match(t, /split by loss size\)/);
  assert.doesNotMatch(t, /split by loss size\.\)/);
});

// Review finding (buy.mjs:157 area): a halted plan's own buy never reads its open sends back again, so telling the
// user to "try again after the next scheduled run reads it back" is false for exactly this case. stop is what
// actually clears it.
test('confirm refuses while a halted plan still has an open send, and says stop clears it, not the schedule', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' });
  const halted = activePlan(ctx.store.readLedger(), CALL).id;
  ctx.store.appendLedger({
    kind: 'buy_sent', planId: halted, period: '2026-10-05', instId: 'ETH-USDT', clOrdId: 'akopen1', amount: '10.00', lossPct: 10, profile: 't', env: 'live',
  }, T0);
  ctx.store.appendLedger({ kind: 'plan_halted', planId: halted, profile: 't', env: 'live', reason: 'test halt' }, T0);
  const next = { ...flags, method: 'equal' };
  await planVerb(ctx, next);
  assert.equal(await planVerb(ctx, { ...next, confirm: 'AVGPLAN' }), 1);
  assert.match(text(ctx), /REFUSED: a buy on this profile has a result that is not recorded yet \(order\(s\) akopen1\)\. The plan that sent it is halted and never reads it back on its own\. Run stop to clear it, then make a new plan\./);
  assert.doesNotMatch(text(ctx), /try again after the next scheduled run reads it back/);
});

// Review finding (planview.mjs:107): a torn ledger line already refuses every buy (buy.mjs). The card must say so
// too (rule 4, a fact one surface knows every surface knows), and confirm must refuse outright rather than start a
// plan that could never buy.
test('the plan card warns about a torn ledger line, and confirm refuses while it is torn', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), '{"kind":"plan_halted","planId":\n');
  await planVerb(ctx, flags);
  assert.ok(text(ctx).includes(`could not be read and was skipped`) && text(ctx).includes(ctx.store.home), text(ctx));
  ctx.lines.length = 0;
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 1);
  assert.ok(text(ctx).includes(`could not be read and was skipped`) && text(ctx).includes(ctx.store.home), text(ctx));
  assert.match(text(ctx), /REFUSED:.*ledger line/);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null, 'no plan was started');
});

// Review finding (planview.mjs:107, mutation review): the torn check above sits before freshCard is ever
// consulted, precisely so a torn ledger is the refusal the user reads even when no card was ever shown for this
// id. confirmLocked's own confirmRefusal also checks ledger.torn, but only after freshCard passes; a cold confirm
// (no plan_card on record at all) hits freshCard first and would print "show the plan card first" instead, hiding
// the real, unrelated-to-cards reason every buy already refuses.
test('confirm run cold, with no card ever shown, leads with the torn-ledger refusal, not "show the plan card first"', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  fs.appendFileSync(path.join(ctx.store.home, 'ledger.jsonl'), '{"kind":"plan_active","id":\n');
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 1);
  const t = text(ctx);
  assert.match(t, /REFUSED: a plan cannot be confirmed while a ledger line cannot be read/);
  assert.doesNotMatch(t, /show the plan card first/);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null, 'no plan was started');
});

test('confirm refuses while another run holds the buy lock, and releases the lock it takes', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  const held = ctx.store.lock('buy-t-live');
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 1);
  assert.match(text(ctx), /REFUSED: Another AvgKeeper run holds the buy lock for this profile\. Try again in a few minutes\./);
  assert.doesNotMatch(text(ctx), /scheduled buy is running/);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null);
  held();
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 0);
  const again = ctx.store.lock('buy-t-live');
  assert.ok(again);
  again();
});

// Review finding (planview.mjs:73): staleLockLine's non-read-only form always said "AvgKeeper could not buy",
// which reads oddly for confirm, whose own action is starting a new plan, not buying.
// Review finding (plan.mjs:146 area, later): a stale lock held by a live pid already makes confirm refuse
// (staleLockLine below), but confirmRefusal never checked for it, so the card still ended "To start it, type
// AVGPLAN" for a confirm certain to be refused (the a9980e6 fix covered only a torn ledger and an unsettled send).
test('the card previews a stale-lock refusal instead of inviting AVGPLAN', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  const old = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(f, old, old);
  ctx.lines.length = 0;
  await planVerb(ctx, flags);
  const t = text(ctx);
  assert.doesNotMatch(t, /To start it, type AVGPLAN/, t);
  assert.match(t, /AVGPLAN would be refused right now: The buy lock from \d{4}-\d\d-\d\dT\d\d:\d\dZ is still held/, t);
});

test('confirm refuses on a stale lock saying it could not start the new plan, never "could not buy"', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  const f = path.join(ctx.store.home, 'buy-t-live.lock');
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: 1 }));
  const old = (Date.now() - 20 * 60000) / 1000;
  fs.utimesSync(f, old, old);
  assert.equal(await planVerb(ctx, { ...flags, confirm: 'AVGPLAN' }), 1);
  const t = text(ctx);
  assert.match(t, /REFUSED: AvgKeeper could not start the new plan: a lock from \d{4}-\d\d-\d\dT\d\d:\d\dZ/);
  assert.doesNotMatch(t, /could not buy/);
  assert.equal(activePlan(ctx.store.readLedger(), CALL), null);
});

test('a scheduled run cannot make a plan; no Builder Code refuses outside owner test', async () => {
  const s = makeCtx({ env: { ...OWNER, AVGKEEPER_SCHEDULED: '1' }, okx: fakeExchange(LOSING) });
  assert.equal(await planVerb(s, flags), 1);
  const c = makeCtx({ okx: fakeExchange(LOSING) });
  assert.equal(await planVerb(c, flags), 1);
  assert.match(text(c), /no AI Builder Code/);
});

// Review finding (buy.mjs:368, plan.mjs:68): the time zone was never varied, so a mutant that dropped it from
// planId's own hash would still pass. Two plans with the same fields, made in different time zones, must never
// collide: dueNow reads the plan's own time zone, so the same clOrdId for two zones could settle the wrong send.
test('the plan id changes with any field, profile, mode or time zone', () => {
  const f = readPlanFlags(flags).fields;
  const a = planId(f, CALL, 'Europe/Istanbul');
  assert.notEqual(a, planId({ ...f, budget: '11.00' }, CALL, 'Europe/Istanbul'));
  assert.notEqual(a, planId(f, { profile: 't', demo: true }, 'Europe/Istanbul'));
  assert.notEqual(a, planId(f, CALL, 'America/New_York'));
  assert.match(a, /^p[0-9a-f]{12}$/);
});

test('monthly estimate per cadence', () => {
  assert.equal(monthlyUsdt({ budget: '10.00', cadence: 'hour' }), 7200);
  assert.equal(monthlyUsdt({ budget: '10.00', cadence: 'day' }), 300);
  assert.equal(monthlyUsdt({ budget: '10.00', cadence: 'days:2' }), 150);
  assert.equal(Math.round(monthlyUsdt({ budget: '12.00', cadence: 'week:mon' })), 52);
  assert.equal(monthlyUsdt({ budget: '10.00', cadence: 'month:1' }), 10);
});

// Section 10: an hourly plan's own card and plan_active record.
test('an hourly plan cards, confirms and records with unchanged field shapes', async () => {
  const hourly = { profile: 't', budget: '10', every: 'hour', method: 'equal' };
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  assert.equal(await planVerb(ctx, hourly), 0);
  const t = text(ctx);
  assert.match(t, /10\.00 USDT every hour at :05 \(Europe\/Istanbul\), split equally\./);
  assert.match(t, /about 7200\.00 USDT a month/);
  assert.match(t, /Hourly: 24 buys a day\./);
  assert.equal(await planVerb(ctx, { ...hourly, confirm: 'AVGPLAN' }), 0);
  const plan = activePlan(ctx.store.readLedger(), CALL);
  assert.equal(plan.cadence, 'hour');
  assert.equal(plan.at, ':05');
  assert.equal(plan.anchorDate, '2026-10-05');
  assert.equal(plan.activeFrom, '2026-10-05 10:00');
  assert.match(plan.id, /^p[0-9a-f]{12}$/);
});

test('a daily plan card never shows the hourly line', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  await planVerb(ctx, flags);
  assert.doesNotMatch(text(ctx), /Hourly: 24 buys a day\./);
});

// Item 6 of the 2026-09-27 release audit: the plan card warns when the account's key has no IP bound and the
// plan's own cadence can leave OKX untouched past OKX's own 14-day key inactivity window.
test('the plan card warns when the key has no IP bound and the cadence can leave a gap past 14 days', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange({ ...LOSING, ip: '' }) });
  assert.equal(await planVerb(ctx, { ...flags, every: 'days:20' }), 0);
  assert.match(text(ctx), /WARNING: this API key has no IP address bound to it\..*okx\.com\/en-us\/help\/api-faq/s);
});

test('the plan card does not warn once the key has an IP bound, or when the cadence stays under 14 days', async () => {
  const withIp = makeCtx({ env: OWNER, okx: fakeExchange({ ...LOSING, ip: '1.2.3.4' }) });
  assert.equal(await planVerb(withIp, { ...flags, every: 'days:20' }), 0);
  assert.doesNotMatch(text(withIp), /WARNING: this API key has no IP/);

  const daily = makeCtx({ env: OWNER, okx: fakeExchange({ ...LOSING, ip: '' }) });
  assert.equal(await planVerb(daily, flags), 0);
  assert.doesNotMatch(text(daily), /WARNING: this API key has no IP/);
});

// Review finding (plan.mjs:139): the receipt (confirm's own printed output, the user's last screen before
// installing the schedule) dropped two warnings the card just showed for the same plan: the key inactivity WARNING
// and, for an hourly plan, the Hourly line.
test('the receipt keeps the key inactivity warning the card just showed', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange({ ...LOSING, ip: '' }) });
  await planVerb(ctx, { ...flags, every: 'days:20' });
  ctx.lines.length = 0;
  assert.equal(await planVerb(ctx, { ...flags, every: 'days:20', confirm: 'AVGPLAN' }), 0);
  assert.match(text(ctx), /WARNING: this API key has no IP address bound to it\..*okx\.com\/en-us\/help\/api-faq/s);
});

test('the receipt keeps the Hourly line for an hourly plan', async () => {
  const ctx = makeCtx({ env: OWNER, okx: fakeExchange(LOSING) });
  const hourly = { profile: 't', budget: '10', every: 'hour', method: 'equal' };
  await planVerb(ctx, hourly);
  ctx.lines.length = 0;
  assert.equal(await planVerb(ctx, { ...hourly, confirm: 'AVGPLAN' }), 0);
  assert.match(text(ctx), /Hourly: 24 buys a day\./);
});
