// avgkeeper/tests/allocate.test.mjs
import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { split, fitMinimums, meetsMinimum } from '../scripts/allocate.mjs';

const eth = { ccy: 'ETH', lossPct: 10 };
const btc = { ccy: 'BTC', lossPct: 5 };
const cents = (shares) => Object.fromEntries(shares.map((s) => [s.ccy, s.cents]));

test('the spec examples: weighted day 1 and day 2, and equal', () => {
  assert.deepEqual(cents(split([eth, btc], 1000, 'weighted')), { ETH: 667, BTC: 333 });
  assert.deepEqual(cents(split([{ ccy: 'ETH', lossPct: 3 }, { ccy: 'BTC', lossPct: 19 }], 1000, 'weighted')), { BTC: 864, ETH: 136 });
  assert.deepEqual(cents(split([eth, btc], 1000, 'equal')), { ETH: 500, BTC: 500 });
});

test('shares always add up to the budget', () => {
  const three = [{ ccy: 'A', lossPct: 1 }, { ccy: 'B', lossPct: 1 }, { ccy: 'C', lossPct: 1 }];
  const s = split(three, 1000, 'equal');
  assert.equal(s.reduce((t, x) => t + x.cents, 0), 1000);
  assert.deepEqual(s.map((x) => x.cents), [334, 333, 333]);
});

test('no coins, no shares', () => {
  assert.deepEqual(split([], 1000, 'equal'), []);
});

const inst = (minSz) => ({ minSz, lotSz: '0.00000001' });

test('meetsMinimum compares the floored size with minSz', () => {
  assert.equal(meetsMinimum(100, { inst: inst('0.00001'), last: '84000' }), true);
  assert.equal(meetsMinimum(50, { inst: inst('0.00001'), last: '84000' }), false);
  assert.equal(meetsMinimum(100, { inst: inst('0.00001'), last: null }), false);
  assert.equal(meetsMinimum(100, undefined), false);
});

test('a share below the minimum is dropped and its money goes to the others', () => {
  const market = new Map([
    ['ETH', { inst: inst('0.001'), last: '1767.30' }],
    ['BTC', { inst: inst('0.00001'), last: '84000' }],
  ]);
  const { shares, dropped } = fitMinimums([{ ccy: 'ETH', lossPct: 99 }, { ccy: 'BTC', lossPct: 1 }], 1000, 'weighted', market);
  assert.deepEqual(cents(shares), { ETH: 1000 });
  assert.deepEqual(dropped.map((d) => d.ccy), ['BTC']);
});

test('dropping the smallest failing coin can lift another over its minimum', () => {
  // B (2.10 USDT) and C (1.90 USDT) both buy under 1 unit at 2.5; dropping C gives B 2.59 USDT, 1.036 units.
  const market = new Map([
    ['A', { inst: inst('1'), last: '1' }],
    ['B', { inst: inst('1'), last: '2.5' }],
    ['C', { inst: inst('1'), last: '2.5' }],
  ]);
  const coins = [{ ccy: 'A', lossPct: 60 }, { ccy: 'B', lossPct: 21 }, { ccy: 'C', lossPct: 19 }];
  const { shares, dropped } = fitMinimums(coins, 1000, 'weighted', market);
  assert.deepEqual(dropped.map((d) => d.ccy), ['C']);
  assert.deepEqual(shares.map((s) => s.ccy), ['A', 'B']);
});

// Review finding (buy.mjs:368, allocate.mjs:39): the tie order between two equally-failing shares (same cents, same
// lossPct) had no test: fitMinimums' own sort falls through to comparing ccy, alphabetically later dropped first.
test('a tie between two equally failing shares drops the alphabetically later ccy first', () => {
  const market = new Map([
    ['AAA', { inst: inst('1000'), last: '1' }],
    ['BBB', { inst: inst('1000'), last: '1' }],
  ]);
  const coins = [{ ccy: 'AAA', lossPct: 10 }, { ccy: 'BBB', lossPct: 10 }];
  const { dropped } = fitMinimums(coins, 1000, 'equal', market);
  assert.equal(dropped[0].ccy, 'BBB');
});

test('everything below the minimum leaves no shares', () => {
  const market = new Map([['ETH', { inst: inst('1'), last: '1767.30' }]]);
  const { shares } = fitMinimums([eth], 1000, 'equal', market);
  assert.deepEqual(shares, []);
});
