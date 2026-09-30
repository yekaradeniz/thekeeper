// avgkeeper/tests/holdings.test.mjs
import { bal } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  holdingRows, usdtAvailable, candidates, USD_PEGGED, unreadableCoins, unreadableLine, notHeldLine,
  WHY_IN_PROFIT, WHY_LOSS_UNREADABLE, WHY_VALUE_UNREADABLE, WHY_PRICE_UNREADABLE,
} from '../scripts/holdings.mjs';

const pairs = new Map(['ETH', 'BTC', 'SOL', 'PEPE', 'XAUT', 'USDC'].map((c) => [`${c}-USDT`, { instId: `${c}-USDT` }]));
const reply = {
  data: [{
    details: [
      bal('USDT', { eqUsd: '1484.90', availBal: '1484.90', openAvgPx: '', spotUplRatio: '' }),
      bal('ETH', { eqUsd: '208.90', spotUplRatio: '-0.10' }),
      bal('BTC', { eqUsd: '809.86', spotUplRatio: '-0.05' }),
      bal('SOL', { eqUsd: '406.24', spotUplRatio: '0.1955' }),
      bal('PEPE', { eqUsd: '0.50', spotUplRatio: '-0.60' }),
      bal('USDC', { eqUsd: '50', spotUplRatio: '-0.001' }),
      bal('XAUT', { eqUsd: '993.62', spotUplRatio: '' }),
      bal('ABC', { eqUsd: '20', spotUplRatio: '-0.2' }),
    ],
  }],
};
const base = { only: null, exclude: null, dust: '10.00' };

test('holdingRows reads every figure through num', () => {
  const rows = holdingRows(reply);
  const usdt = rows.find((r) => r.ccy === 'USDT');
  assert.ok(Number.isNaN(usdt.uplRatio));
  assert.equal(usdtAvailable(rows), 1484.9);
  assert.ok(Number.isNaN(usdtAvailable(holdingRows({ data: [{ details: [] }] }))));
});

test('candidates keeps coins in loss and says why the rest are out', () => {
  const { inPlan, out } = candidates(holdingRows(reply), base, pairs);
  assert.deepEqual(inPlan.map((c) => c.ccy), ['ETH', 'BTC']);
  assert.equal(Math.round(inPlan[0].lossPct * 100) / 100, 10);
  const why = Object.fromEntries(out.map((c) => [c.ccy, c.why]));
  assert.deepEqual(why, {
    SOL: 'in profit',
    PEPE: 'worth under 10.00 USDT',
    USDC: 'a dollar stablecoin',
    XAUT: 'OKX sent no profit or loss figure for it',
    ABC: 'no USDT spot pair on OKX',
  });
});

test('an exclude list removes a coin', () => {
  const { inPlan, out } = candidates(holdingRows(reply), { ...base, exclude: ['ETH'] }, pairs);
  assert.deepEqual(inPlan.map((c) => c.ccy), ['BTC']);
  assert.equal(out.find((c) => c.ccy === 'ETH').why, 'on your exclude list');
});

test('an only-these list keeps its coins even below the dust threshold', () => {
  const { inPlan, out } = candidates(holdingRows(reply), { ...base, only: ['PEPE', 'BTC'] }, pairs);
  assert.deepEqual(inPlan.map((c) => c.ccy).sort(), ['BTC', 'PEPE']);
  assert.equal(out.find((c) => c.ccy === 'ETH').why, 'not on your only-these list');
});

test('a stablecoin stays out even on an only-these list', () => {
  const { inPlan } = candidates(holdingRows(reply), { ...base, only: ['USDC'] }, pairs);
  assert.deepEqual(inPlan, []);
});

// Review finding (holdings.mjs:106): a typo'd or sold-off coin on the only-these list never had a row at all, so
// it was invisible to the loop and never landed in `out` either. It is named now, with its own reason.
test('an only-these coin the account does not hold at all is named as not held, never just missing', () => {
  const { inPlan, out } = candidates(holdingRows(reply), { ...base, only: ['ETHH'] }, pairs);
  assert.deepEqual(inPlan, []);
  const ethh = out.find((c) => c.ccy === 'ETHH');
  assert.ok(ethh, out.map((c) => c.ccy).join(','));
  assert.equal(ethh.why, 'not in this account');
});

// New regression: the USDT row is skipped before the loop ever marks it "seen" (it is cash, never a buy
// candidate), so an only-these list naming USDT (readPlanFlags accepts it) always read USDT as a coin the account
// does not hold at all, even on an account that plainly holds USDT.
test('USDT on an only-these list is never named as not held when the account holds USDT', () => {
  const { inPlan, out } = candidates(holdingRows(reply), { ...base, only: ['USDT', 'ETH'] }, pairs);
  assert.deepEqual(inPlan.map((c) => c.ccy), ['ETH']);
  assert.notEqual(out.find((c) => c.ccy === 'USDT'), undefined, JSON.stringify(out));
});

// Review finding (cards.mjs:84, should): USDT used to vanish entirely from an only-these list (not in, not out).
// Named now, with its own reason, the way every other left-out only-these coin already is.
test('USDT on an only-these list is named as the budget currency, never invisible, and never twice', () => {
  const { out } = candidates(holdingRows(reply), { ...base, only: ['USDT', 'ETH'] }, pairs);
  const usdtRows = out.filter((c) => c.ccy === 'USDT');
  // Exactly one: USDT is marked "seen" the same call that gives it its own reason, so it never also falls through
  // to the not-held check below (which would add a second, contradicting entry).
  assert.equal(usdtRows.length, 1, out.map((c) => `${c.ccy}:${c.why}`).join(','));
  assert.equal(usdtRows[0].why, 'the budget currency itself, never something to buy');
});

// Review finding (holdings.mjs:178, blocker): reasonOut checked pair liveness before the dust and loss checks, so
// an in-profit coin, or a dust coin, whose pair happens to be suspended was reported "in loss, but its pair is not
// trading" without its loss (or dust) ever being checked at all. A coin genuinely in loss with a suspended pair
// must still get that reason.
test('a suspended pair is named "in loss" only once a coin is actually checked and found in loss', () => {
  const suspended = new Map(pairs);
  suspended.set('SOL-USDT', { instId: 'SOL-USDT', state: 'suspend' });
  suspended.set('PEPE-USDT', { instId: 'PEPE-USDT', state: 'suspend' });
  suspended.set('LUNC-USDT', { instId: 'LUNC-USDT', state: 'suspend' });
  const withLunc = {
    data: [{ details: [...reply.data[0].details, bal('LUNC', { eqUsd: '50', spotUplRatio: '-0.40' })] }],
  };
  const { out } = candidates(holdingRows(withLunc), base, suspended);
  const why = Object.fromEntries(out.map((c) => [c.ccy, c.why]));
  assert.equal(why.SOL, WHY_IN_PROFIT, 'SOL is in profit; its suspended pair is not why it is left out');
  assert.equal(why.PEPE, 'worth under 10.00 USDT', 'PEPE is dust; its suspended pair is not why it is left out');
  assert.match(why.LUNC, /its USDT pair is not trading on OKX right now \(state suspend\)/, 'LUNC is genuinely in loss, so the suspended pair is in fact why it is left out');
});

test('notHeldLine names one or several only-these coins the account does not hold, singular and plural', () => {
  assert.equal(notHeldLine([{ ccy: 'ETH', why: 'in profit' }]), '');
  assert.equal(
    notHeldLine([{ ccy: 'ETHH', why: 'not in this account' }]),
    'ETHH is on your only-these list, but this account does not hold it; not bought.',
  );
  assert.equal(
    notHeldLine([{ ccy: 'ETHH', why: 'not in this account' }, { ccy: 'BTCC', why: 'not in this account' }]),
    'ETHH, BTCC are on your only-these list, but this account does not hold them; not bought.',
  );
});

test('the stablecoin list holds dollar coins and not gold', () => {
  assert.ok(USD_PEGGED.has('USDC'));
  assert.ok(!USD_PEGGED.has('XAUT'));
});

test('holdingRows refuses when the same ccy appears in two detail rows', () => {
  const dup = { data: [{ details: [bal('BTC', { eqUsd: '100' }), bal('BTC', { eqUsd: '50' })] }] };
  assert.throws(() => holdingRows(dup), /REFUSED: OKX listed BTC twice in the account balance/);
});

// Review finding (today.mjs:17): an empty or malformed read must never pass as a real "you hold nothing" answer.
// data: [{ details: [] }] (an empty portfolio) is a legitimate answer and stays fine (the test above). data: []
// (no element at all) and a shape with no details array anywhere are not: OKX answered something this build
// cannot read as an account, never proof the account is empty.
test('holdingRows throws when the reply has no readable details array anywhere, never reads it as an empty account', () => {
  assert.throws(() => holdingRows({ data: [] }), /account balance/);
  assert.throws(() => holdingRows({ data: [{ totalEq: '2900' }] }), /account balance/);
  assert.throws(() => holdingRows({}), /account balance/);
  assert.throws(() => holdingRows(null), /account balance/);
  // Still fine: a real, structurally sound empty account.
  assert.deepEqual(holdingRows({ data: [{ details: [] }] }), []);
});

// Item 2 of the 2026-09-27 release audit, and findings 1 and 2 of the release-readiness review that followed it:
// every coin left out for an unreadable figure is named, one clause per reason, and each clause says only what its
// reason proves. A coin dropped for an unreadable price had passed the loss check, so it is known to be in loss.
test('unreadableLine names every unreadable coin by reason, whatever the other coins are', () => {
  const out = [
    { ccy: 'SOL', why: WHY_IN_PROFIT },
    { ccy: 'PEPE', why: 'worth under 10.00 USDT' },
    { ccy: 'USDC', why: 'a dollar stablecoin' },
    { ccy: 'ETH', why: WHY_LOSS_UNREADABLE },
    { ccy: 'ABC', why: WHY_VALUE_UNREADABLE },
    { ccy: 'BTC', why: WHY_PRICE_UNREADABLE },
    { ccy: 'XRP', why: WHY_PRICE_UNREADABLE },
  ];
  assert.deepEqual(unreadableCoins(out).map((c) => c.ccy), ['ETH', 'ABC', 'BTC', 'XRP']);
  assert.equal(unreadableLine(out), [
    'OKX sent no profit or loss figure for ETH, so AvgKeeper cannot tell whether it is in loss; not bought.',
    "OKX sent no readable value for ABC, so AvgKeeper cannot tell whether it is worth at least the plan's dust threshold; not bought.",
    'BTC, XRP are in loss, but their price or order size could not be read from OKX; not bought.',
  ].join(' '));
  assert.equal(unreadableLine([{ ccy: 'BTC', why: WHY_PRICE_UNREADABLE }]), 'BTC is in loss, but its price or order size could not be read from OKX; not bought.');
  // Known answers only (in profit, dust, a stablecoin), or nothing at all: nothing to name.
  assert.equal(unreadableLine(out.slice(0, 3)), '');
  assert.equal(unreadableLine([]), '');
});
