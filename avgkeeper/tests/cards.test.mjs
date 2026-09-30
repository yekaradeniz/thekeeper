// avgkeeper/tests/cards.test.mjs
import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitLines, planCard, cadenceWords, monthlyUsdt, HOURLY_LINE, droppedLine, budgetShortfall, noBuyReason,
} from '../scripts/cards.mjs';
import { WHY_PRICE_UNREADABLE, WHY_NOT_HELD } from '../scripts/holdings.mjs';

const P = {
  id: 'p1', profile: 't', budget: '10.00', cadence: 'day', at: '10:00', method: 'equal', only: null, exclude: null, dust: '10.00', timeZone: 'Europe/Istanbul',
};
const T = {
  inPlan: [], shares: [], dropped: [], out: [], usdtAvail: 100,
};

// Item 3 of the demo review: with an only-these list, every excluded coin shares one reason, so the old
// "A (reason), B (reason)" format repeated the same reason once per coin. Coins with the same reason group
// together, in order of first appearance, and every coin is still named (no counts replacing names).
test('splitLines groups the Left out line by reason, keeping every coin name', () => {
  const t = {
    inPlan: [{}],
    shares: [{ ccy: 'ADA', lossPct: 3, cents: 500 }],
    dropped: [],
    out: [
      { ccy: 'BTC', why: 'on your exclude list' },
      { ccy: 'ETH', why: 'on your exclude list' },
      { ccy: 'UNI', why: 'in profit' },
      { ccy: 'LDO', why: 'in profit' },
      { ccy: 'HBAR', why: 'worth under 10.00 USDT' },
      { ccy: 'MANA', why: 'worth under 10.00 USDT' },
    ],
  };
  const lines = splitLines(t);
  const leftOut = lines.find((l) => l.includes('Left out:'));
  assert.equal(
    leftOut.trim(),
    'Left out: BTC, ETH (on your exclude list); UNI, LDO (in profit); HBAR, MANA (worth under 10.00 USDT).',
  );
});

// A single coin per reason still reads correctly, and coins never disappear behind a count.
test('splitLines with one coin per reason names each coin, no counts', () => {
  const t = {
    inPlan: [],
    shares: [],
    dropped: [],
    out: [
      { ccy: 'DOGE', why: 'not on your only-these list' },
      { ccy: 'XRP', why: 'in profit' },
    ],
  };
  const lines = splitLines(t);
  const leftOut = lines.find((l) => l.includes('Left out:'));
  assert.equal(leftOut.trim(), 'Left out: DOGE (not on your only-these list); XRP (in profit).');
  assert.doesNotMatch(leftOut, /\d+ coins?/);
});

// Finding 1 of the 2026-09-27 release-readiness review, on the card and the dry run too (ProjectBuilder CLAUDE.md
// rule 4): a coin left out for an unreadable figure means "no coin is in loss" has nothing behind it. A coin left
// out for its price had already passed the loss check, so for it the sentence is false.
test('splitLines never says no coin is in loss while a coin was left out for an unreadable figure', () => {
  const unreadable = splitLines({ ...T, out: [{ ccy: 'XRP', why: 'in profit' }, { ccy: 'BTC', why: 'its price or order size could not be read from OKX' }] });
  assert.equal(unreadable[0], '  No coin in the plan can be bought right now, so it would buy nothing.');
  assert.ok(!unreadable.join('\n').includes('is in loss right now'), unreadable.join('\n'));
  const known = splitLines({ ...T, out: [{ ccy: 'XRP', why: 'in profit' }] });
  assert.equal(known[0], '  No coin in the plan is in loss right now, so it would buy nothing.');
});

// droppedLine is the one builder every surface that shows a drop uses (ProjectBuilder CLAUDE.md rule 4): the plan
// card, buy --dry-run (both through splitLines below), the buy summary and status (buy.mjs, manage.mjs). The only
// cause it may state is that the coin's share was below OKX's minimum order size.
test('droppedLine names every dropped coin and states no other cause; null when nothing was dropped', () => {
  assert.equal(droppedLine([]), null);
  assert.equal(droppedLine(undefined), null);
  assert.equal(
    droppedLine([{ ccy: 'TRX', cents: 8 }, { ccy: 'BTC', cents: 51 }]),
    "Too small for OKX's minimum order: TRX, BTC. Their share went to the others.",
  );
});

test('splitLines prints the dropped line, for one coin and for several', () => {
  const one = splitLines({ ...T, inPlan: [{}], shares: [{ ccy: 'LTC', lossPct: 5, cents: 300 }], dropped: [{ ccy: 'BTC', cents: 51 }] });
  assert.ok(one.includes("  Too small for OKX's minimum order: BTC. Their share went to the others."), one.join('\n'));
  const many = splitLines({
    ...T, inPlan: [{}], shares: [{ ccy: 'LTC', lossPct: 5, cents: 300 }], dropped: [{ ccy: 'TRX', cents: 8 }, { ccy: 'BTC', cents: 51 }, { ccy: 'ETH', cents: 144 }],
  });
  assert.ok(many.includes("  Too small for OKX's minimum order: TRX, BTC, ETH. Their share went to the others."), many.join('\n'));
});

// Review finding (cards.mjs:48): "Their share went to the others" is false when every coin in loss was itself
// dropped for OKX's minimum: nothing was bought, so there is no "others" left to receive a share.
test('droppedLine never says a share went to the others when no share remains', () => {
  const none = splitLines({ ...T, inPlan: [{}], shares: [], dropped: [{ ccy: 'BTC', cents: 5 }, { ccy: 'ETH', cents: 3 }] });
  assert.ok(none.includes("  Too small for OKX's minimum order: BTC, ETH."), none.join('\n'));
  assert.ok(!none.some((l) => l.includes('Their share went to the others')), none.join('\n'));
  assert.ok(none.includes("  Every coin in loss has a share below OKX's minimum order size, so it would buy nothing."), none.join('\n'));
});

// Spec section 9, "Surfaces": the plan card prints the mail line from mail.mjs's own mailLine, the one helper the
// receipt also uses (plan.test.mjs pins the receipt's own line).
test('planCard prints the mail line from mailLine, off by default', () => {
  const lines = planCard(P, 'live', T);
  assert.ok(lines.includes('Mail: off.'), lines.join('\n'));
});

test('planCard prints the mail line matching the account config, problems or all', () => {
  const problems = planCard(P, 'live', T, null, { mail: { to: 'a@b.co', level: 'problems' } });
  assert.ok(problems.includes('Mail: problems only, to a@b.co.'), problems.join('\n'));
  const all = planCard(P, 'live', T, null, { mail: { to: 'a@b.co', level: 'all' } });
  assert.ok(all.includes('Mail: every buy with its details, to a@b.co.'), all.join('\n'));
});

// Review finding (buy.mjs:442, blocker): the card would show a split assuming enough free USDT even when there is
// not, so a user reading it would not know today's buy would in fact skip. budgetShortfall is the one reader the
// card, the dry run and the real buyPeriod all use (rule 3).
test('budgetShortfall reads plan and split the same way buyPeriod itself checks the gate', () => {
  assert.equal(budgetShortfall(P, { ...T, usdtAvail: 10 }), null, 'exactly the budget is enough');
  assert.equal(budgetShortfall(P, { ...T, usdtAvail: 5 }), 'free USDT 5.00, below the 10.00 USDT this buy needs.');
  assert.equal(budgetShortfall(P, { ...T, usdtAvail: NaN }), "free USDT could not be read, so it counts as too little, below the 10.00 USDT this buy needs.");
  assert.equal(budgetShortfall(P, null), null, 'no split read yet is never a shortfall to name');
});

// New (finding 10(b) remaining): noBuyReason is the one reader buyPeriod and the dry run both use, in this exact
// order: an unreadable coin, an only-these coin not held, no coin in loss, every coin below OKX's minimum, then
// free USDT below the budget. Before this, the dry run checked only the budget, so a day with both no coin in
// loss and a shortfall had the dry run name the wrong one.
test('noBuyReason checks unreadable, not-held, no-loss, below-minimum, then the budget, in that order', () => {
  const shares = [{ ccy: 'ETH', lossPct: 10, cents: 1000 }];
  assert.deepEqual(
    noBuyReason(P, { ...T, out: [{ ccy: 'ETH', why: WHY_PRICE_UNREADABLE }] }),
    { reason: 'ETH is in loss, but its price or order size could not be read from OKX; not bought.', severity: 'problem' },
  );
  assert.deepEqual(
    noBuyReason(P, { ...T, out: [{ ccy: 'ETH', why: WHY_NOT_HELD }] }),
    { reason: 'ETH is on your only-these list, but this account does not hold it; not bought.', severity: 'problem' },
  );
  assert.deepEqual(noBuyReason(P, T), { reason: 'no coin in the plan is in loss.', severity: 'info' });
  assert.deepEqual(
    noBuyReason(P, {
      ...T, inPlan: shares, shares: [], dropped: [{ ccy: 'ETH' }],
    }),
    { reason: "every coin in loss had a share below OKX's minimum order size (ETH).", severity: 'problem' },
  );
  assert.deepEqual(
    noBuyReason(P, {
      ...T, inPlan: shares, shares, usdtAvail: 5,
    }),
    { reason: 'free USDT 5.00, below the 10.00 USDT this buy needs.', severity: 'problem' },
  );
  assert.equal(noBuyReason(P, {
    ...T, inPlan: shares, shares, usdtAvail: 100,
  }), null);
  // Precedence: no coin in loss wins over a budget shortfall, the same order buyPeriod checks them in.
  assert.deepEqual(noBuyReason(P, { ...T, usdtAvail: 5 }), { reason: 'no coin in the plan is in loss.', severity: 'info' });
});

// Review finding (cards.mjs:87, later): when every readable coin in loss was dropped for OKX's minimum AND another
// coin in loss was left out for an unreadable price, "every coin in loss had a share below OKX's minimum" is false
// (the unreadable coin got no share at all) and that coin goes unnamed. buyPeriod already adds these lines to its
// own problems list on a day that buys; noBuyReason must add them here too, on the days it does not.
test('noBuyReason names an unreadable coin beside every readable coin dropped for OKX\'s minimum', () => {
  const shares = [{ ccy: 'BTC', lossPct: 5, cents: 1000 }];
  assert.deepEqual(
    noBuyReason(P, {
      ...T, inPlan: shares, shares: [], dropped: [{ ccy: 'BTC' }], out: [{ ccy: 'ETH', why: WHY_PRICE_UNREADABLE }],
    }),
    {
      reason: "every readable coin in loss had a share below OKX's minimum order size (BTC). ETH is in loss, but its price or order size could not be read from OKX; not bought.",
      severity: 'problem',
    },
  );
  // The same addition applies to the budget-shortfall reason, the other branch that used to say nothing about a
  // coin left out for an unreadable figure or a not-held coin.
  assert.deepEqual(
    noBuyReason(P, {
      ...T, inPlan: shares, shares, usdtAvail: 5, out: [{ ccy: 'ETH', why: WHY_NOT_HELD }],
    }),
    {
      reason: 'free USDT 5.00, below the 10.00 USDT this buy needs. ETH is on your only-these list, but this account does not hold it; not bought.',
      severity: 'problem',
    },
  );
});

// Review finding (cards.mjs:84, should): an only-these plan whose every named coin was left out for a
// configuration reason (a dollar stablecoin, no USDT pair, or USDT itself) never reaches the loss check at all.
// "no coin in the plan is in loss" is false for it, and at the default severity the plan buys nothing forever with
// no alert (the not-held case was already raised to problem severity for the same reason).
test('noBuyReason skips at problem severity when every only-these coin was left out for a configuration reason', () => {
  const onlyPlan = { ...P, only: ['XYZ'] };
  assert.deepEqual(
    noBuyReason(onlyPlan, { ...T, out: [{ ccy: 'XYZ', why: 'no USDT spot pair on OKX' }] }),
    { reason: 'XYZ has no USDT spot pair on OKX; not bought.', severity: 'problem' },
  );
  const usdcPlan = { ...P, only: ['USDC'] };
  assert.deepEqual(
    noBuyReason(usdcPlan, { ...T, out: [{ ccy: 'USDC', why: 'a dollar stablecoin' }] }),
    { reason: 'USDC is a dollar stablecoin, which never counts; not bought.', severity: 'problem' },
  );
  const usdtPlan = { ...P, only: ['USDT'] };
  assert.deepEqual(
    noBuyReason(usdtPlan, { ...T, out: [{ ccy: 'USDT', why: 'the budget currency itself, never something to buy' }] }),
    { reason: 'USDT is the budget currency itself, never something to buy; not bought.', severity: 'problem' },
  );
  // An ordinary plan (no --only) never raises this: a portfolio full of stablecoins is not a config mismatch.
  assert.deepEqual(
    noBuyReason(P, { ...T, out: [{ ccy: 'USDC', why: 'a dollar stablecoin' }] }),
    { reason: 'no coin in the plan is in loss.', severity: 'info' },
  );
});

// Review finding (cards.mjs, should): the comment above said "every named coin", but the code raised the config
// reason whenever ANY only-coin was config-excluded. --only BTC,USDC with BTC in profit named USDC's stablecoin
// status as the cause and raised it to problem severity, although BTC being in profit is what actually decided
// this was a no-loss day; USDC was never the reason nothing bought.
test('noBuyReason keeps the quiet no-loss day when only some only-these coins are config-excluded', () => {
  const mixedPlan = { ...P, only: ['BTC', 'USDC'] };
  assert.deepEqual(
    noBuyReason(mixedPlan, { ...T, out: [{ ccy: 'BTC', why: 'in profit' }, { ccy: 'USDC', why: 'a dollar stablecoin' }] }),
    { reason: 'no coin in the plan is in loss. USDC is a dollar stablecoin, which never counts; not bought.', severity: 'info' },
  );
});

test('planCard adds a line when free USDT is below the budget, right after the split', () => {
  const inLoss = {
    ...T, inPlan: [{}], shares: [{ ccy: 'ETH', lossPct: 10, cents: 1000 }],
  };
  const short = planCard(P, 'live', { ...inLoss, usdtAvail: 5 });
  const idx = short.indexOf('Right now it would skip: free USDT 5.00, below the 10.00 USDT this buy needs.');
  assert.ok(idx > -1, short.join('\n'));
  assert.ok(idx > short.indexOf('If it ran now:'), 'the line comes after the split, not before it');
  const enough = planCard(P, 'live', { ...inLoss, usdtAvail: 100 });
  assert.doesNotMatch(enough.join('\n'), /Right now it would skip/);
});

// Review finding (cards.mjs:146, later): the card built its "Right now it would skip" line from budgetShortfall
// alone, whatever the real skip reason is. noBuyReason checks no-loss before the budget (buyPeriod's own order), so
// on a day with no coin in loss AND free USDT below budget, the real run skips for "no coin in the plan is in
// loss", never the budget. The card must name the same reason, not a second, contradicting one.
test('planCard never adds a budget line when the real reason to skip is no coin in loss', () => {
  const noLossAndShort = planCard(P, 'live', { ...T, usdtAvail: 5 }); // T has no coin in loss (module default)
  assert.doesNotMatch(noLossAndShort.join('\n'), /Right now it would skip/);
  assert.ok(noLossAndShort.includes('  No coin in the plan is in loss right now, so it would buy nothing.'), noLossAndShort.join('\n'));
});

// Review finding (cards.mjs:21, should): isBuyDay buys on min(day, daysInMonth), so a month:15 plan buys on the
// 15th even in February. The parenthetical only ever means something for day 29, 30 or 31 (spec section 2).
test('cadenceWords only adds the shorter-month clause for a day that can fall outside February', () => {
  assert.equal(cadenceWords('month:15'), 'on day 15 of every month');
  assert.equal(cadenceWords('month:1'), 'on day 1 of every month');
  assert.equal(cadenceWords('month:28'), 'on day 28 of every month');
  assert.equal(cadenceWords('month:29'), 'on day 29 of every month (the last day in a shorter month)');
  assert.equal(cadenceWords('month:30'), 'on day 30 of every month (the last day in a shorter month)');
  assert.equal(cadenceWords('month:31'), 'on day 31 of every month (the last day in a shorter month)');
});

// Section 10: hourly cadence words and the 720-buy estimate (30 x 24).
test('cadenceWords and monthlyUsdt read the hourly cadence', () => {
  assert.equal(cadenceWords('hour'), 'every hour');
  assert.equal(monthlyUsdt({ budget: '10.00', cadence: 'hour' }), 7200);
});

// The card adds the hourly line only for an hourly plan (section 10).
test('planCard adds the hourly line only for an hourly plan', () => {
  const hourlyP = { ...P, cadence: 'hour', at: ':05' };
  const withHour = planCard(hourlyP, 'live', T);
  assert.ok(withHour.includes(HOURLY_LINE), withHour.join('\n'));
  const daily = planCard(P, 'live', T);
  assert.ok(!daily.includes(HOURLY_LINE), daily.join('\n'));
});
