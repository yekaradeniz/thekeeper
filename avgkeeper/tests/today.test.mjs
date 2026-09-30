import { makeCtx, fakeExchange, bal, LOSING, CALL } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxError } from '../scripts/runner.mjs';
import { todaySplit, liveUsdtPairs, lastPrices } from '../scripts/today.mjs';

const plan = { budget: '10.00', method: 'weighted', only: null, exclude: null, dust: '10.00' };

test('todaySplit reads OKX and splits among the coins in loss', async () => {
  const ctx = makeCtx({ okx: fakeExchange(LOSING) });
  const t = await todaySplit(ctx, CALL, plan);
  assert.deepEqual(t.shares.map((s) => [s.ccy, s.cents]), [['ETH', 667], ['BTC', 333]]);
  assert.equal(t.usdtAvail, 1484.9);
  assert.deepEqual(t.out.map((c) => c.ccy), ['SOL']);
});

test('todaySplit reads a ticker only for coins in the plan', async () => {
  const okx = fakeExchange(LOSING);
  await todaySplit(makeCtx({ okx }), CALL, plan);
  const tickers = okx.calls.filter((c) => c.args[0] === 'market' && c.args[1] === 'ticker').map((c) => c.args[2]);
  assert.deepEqual(tickers.sort(), ['BTC-USDT', 'ETH-USDT']);
});

test('an unreadable price drops that coin', async () => {
  const okx = fakeExchange({ ...LOSING, prices: { ...LOSING.prices, 'BTC-USDT': '' } });
  const t = await todaySplit(makeCtx({ okx }), CALL, plan);
  assert.deepEqual(t.shares.map((s) => s.ccy), ['ETH']);
  // Unreadable is never "below OKX's minimum": it moves to out with its own reason, dropped stays empty.
  assert.deepEqual(t.dropped, []);
  const btc = t.out.find((c) => c.ccy === 'BTC');
  assert.equal(btc.why, 'its price or order size could not be read from OKX');
});

// Review finding (today.mjs:49): a ticker last of "0" passes PLAIN_PRICE (digits only) and the truthy readable
// check, so the coin reaches fitMinimums at a zero price and is reported as below OKX's minimum order, a cause
// the code never checked (rule 2), instead of unreadable.
test('a ticker price of "0" is unreadable, never a real price that happens to buy nothing', async () => {
  const okx = fakeExchange({ ...LOSING, prices: { ...LOSING.prices, 'BTC-USDT': '0' } });
  const t = await todaySplit(makeCtx({ okx }), CALL, plan);
  assert.deepEqual(t.shares.map((s) => s.ccy), ['ETH']);
  assert.deepEqual(t.dropped, [], "a price of 0 is unreadable, never 'below OKX's minimum'");
  const btc = t.out.find((c) => c.ccy === 'BTC');
  assert.equal(btc.why, 'its price or order size could not be read from OKX');
});

test('a coin with an unreadable price never drops another coin (allocate/today, the reviewer case)', async () => {
  const balances = [
    bal('USDT', { eqUsd: '1000.00', availBal: '1000.00', openAvgPx: '', spotUplRatio: '' }),
    bal('A', { eqUsd: '100', spotUplRatio: '-0.6' }),
    bal('B', { eqUsd: '100', spotUplRatio: '-0.4' }),
  ];
  const instruments = [
    { instId: 'A-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
    { instId: 'B-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
  ];
  const okx = fakeExchange({ balances, instruments, prices: { 'A-USDT': '', 'B-USDT': '5000' } });
  const t = await todaySplit(makeCtx({ okx }), CALL, plan);
  assert.deepEqual(t.shares, [{ ccy: 'B', lossPct: 40, cents: 1000 }]);
  assert.deepEqual(t.dropped, []);
});

// Review finding (today.mjs:21): an instrument with no readable minSz used to reach the readable check as truthy
// (a blank string is falsy in some checks but this one never applied isPlainPositive at all before this fix), so
// a coin whose order size AvgKeeper cannot read at all could be misread as buyable or as below the minimum.
test('an instrument with no readable minSz is unreadable, never below OKX\'s minimum', async () => {
  const balances = [
    bal('USDT', { eqUsd: '1000.00', availBal: '1000.00', openAvgPx: '', spotUplRatio: '' }),
    bal('BTC', { eqUsd: '500', spotUplRatio: '-0.05' }),
  ];
  const instruments = [
    { instId: 'BTC-USDT', quoteCcy: 'USDT', state: 'live', minSz: '', lotSz: '0.00000001' },
    { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
  ];
  const okx = fakeExchange({ balances, instruments, prices: { 'BTC-USDT': '84000' } });
  const t = await todaySplit(makeCtx({ okx }), CALL, plan);
  assert.deepEqual(t.shares, []);
  assert.deepEqual(t.dropped, []);
  const btc = t.out.find((c) => c.ccy === 'BTC');
  assert.equal(btc.why, 'its price or order size could not be read from OKX');
});

// Review finding (today.mjs:21, and today.mjs:26 which corrects the reason's own wording): a suspended instrument
// has no LIVE USDT pair for that coin; it must never reach the price/minSz check, and never block the rest of the
// account from buying (its share re-splits among the coins that do have a live pair). Round 1 got that part right.
// But the pair is still listed (round 1's fix over-corrected this to WHY_NO_PAIR, the same words a genuinely
// absent pair gets): the coin is left out for its own reason instead, naming the state OKX actually answered.
test('a suspended instrument has no live pair, so the coin is left out before the price check, with its own reason', async () => {
  const balances = [
    bal('USDT', { eqUsd: '1000.00', availBal: '1000.00', openAvgPx: '', spotUplRatio: '' }),
    bal('BTC', { eqUsd: '500', spotUplRatio: '-0.05' }),
    bal('ETH', { eqUsd: '500', spotUplRatio: '-0.10' }),
  ];
  const instruments = [
    { instId: 'BTC-USDT', quoteCcy: 'USDT', state: 'suspend', minSz: '0.00001', lotSz: '0.00000001' },
    { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
  ];
  const okx = fakeExchange({ balances, instruments, prices: { 'BTC-USDT': '84000', 'ETH-USDT': '1767.30' } });
  const t = await todaySplit(makeCtx({ okx }), CALL, plan);
  assert.deepEqual(t.shares.map((s) => s.ccy), ['ETH']);
  const btc = t.out.find((c) => c.ccy === 'BTC');
  assert.equal(btc.why, 'its USDT pair is not trading on OKX right now (state suspend)');
});

// Review finding (today.mjs:26, should): a pair OKX never lists at all is still WHY_NO_PAIR, unchanged; only a
// listed-but-not-live pair gets its own reason.
test('a pair OKX never lists at all keeps the plain "no USDT spot pair" reason', async () => {
  const balances = [
    bal('USDT', { eqUsd: '1000.00', availBal: '1000.00', openAvgPx: '', spotUplRatio: '' }),
    bal('XYZ', { eqUsd: '500', spotUplRatio: '-0.30' }),
    bal('ETH', { eqUsd: '500', spotUplRatio: '-0.10' }),
  ];
  const instruments = [
    { instId: 'ETH-USDT', quoteCcy: 'USDT', state: 'live', minSz: '0.001', lotSz: '0.00000001' },
  ];
  const okx = fakeExchange({ balances, instruments, prices: { 'ETH-USDT': '1767.30' } });
  const t = await todaySplit(makeCtx({ okx }), CALL, plan);
  const xyz = t.out.find((c) => c.ccy === 'XYZ');
  assert.equal(xyz.why, 'no USDT spot pair on OKX');
});

// Review finding (today.mjs:26, probe P5): one ticker's own OKX error (a CLI rejection specific to that
// instrument, "Instrument ID does not exist") used to fail the whole lastPrices call, closing the entire period as
// "OKX could not be read" instead of leaving just that one coin out with its own reason (spec section 5).
test('one ticker\'s own OKX error drops only that coin; the others in loss still split', async () => {
  const real = fakeExchange(LOSING);
  const okx = {
    ...real,
    json: async (args, call) => {
      if (args[0] === 'market' && args[1] === 'ticker' && args[2] === 'BTC-USDT') {
        const text = 'Error: Instrument ID does not exist\nCode: 51001';
        throw new OkxError(text, 'cli', text);
      }
      return real.json(args, call);
    },
  };
  const t = await todaySplit(makeCtx({ okx }), CALL, plan);
  assert.deepEqual(t.shares.map((s) => s.ccy), ['ETH']);
  const btc = t.out.find((c) => c.ccy === 'BTC');
  assert.equal(btc.why, 'its price or order size could not be read from OKX');
});

// A network failure on one ticker must still propagate (never silently swallowed as unreadable), so
// withNetworkRetry (buy.mjs) can retry the whole read the same way it already does for other pre-send reads.
test('a network failure on one ticker still throws, so the caller can retry it', async () => {
  const real = fakeExchange(LOSING);
  const okx = {
    ...real,
    json: async (args, call) => {
      if (args[0] === 'market' && args[1] === 'ticker' && args[2] === 'BTC-USDT') throw new OkxError('connect ECONNREFUSED', 'network');
      return real.json(args, call);
    },
  };
  await assert.rejects(lastPrices(makeCtx({ okx }), CALL, ['ETH-USDT', 'BTC-USDT']), (e) => e.kind === 'network');
});

// New regression (today.mjs:47): an ambiguous OKX server code (50001, 50013, a 5xx) on one ticker is a transient
// answer runner.mjs's own ambiguousCode already treats as worth reading again, not proof that instrument's price
// cannot be read. Swallowing it as unreadable drops the coin and re-splits its share onto the others (and the
// realistic trigger is this transient code, not the near-unreachable "instrument does not exist" case). It must
// propagate like a network failure so withNetworkRetry (buy.mjs) can retry the whole read.
test('an ambiguous OKX server code on one ticker still throws, so the caller can retry it, never drops the coin', async () => {
  const real = fakeExchange(LOSING);
  const okx = {
    ...real,
    json: async (args, call) => {
      if (args[0] === 'market' && args[1] === 'ticker' && args[2] === 'BTC-USDT') {
        const text = 'Error: Systems are busy, please try again later\nCode: 50013';
        throw new OkxError(text, 'cli', text);
      }
      return real.json(args, call);
    },
  };
  await assert.rejects(lastPrices(makeCtx({ okx }), CALL, ['ETH-USDT', 'BTC-USDT']), (e) => e.kind === 'cli');
});

test('todaySplit refuses when the plan budget cannot be read', async () => {
  const okx = fakeExchange(LOSING);
  await assert.rejects(
    todaySplit(makeCtx({ okx }), CALL, { ...plan, budget: 'not a number' }),
    /REFUSED: the plan on record cannot be read \(its budget\)\. Make a new plan\./,
  );
});

// Review finding (today.mjs:17, probe P3): an instruments reply with no rows must never read as "OKX has zero
// USDT spot pairs", which then reads every coin as WHY_NO_PAIR and the buy skips quietly as "no coin in loss".
// This is an unreadable answer, not a real fact about the market.
test('liveUsdtPairs throws when OKX names no live USDT spot pairs at all, never reads it as a real market', async () => {
  const okx = fakeExchange({ ...LOSING, instruments: [] });
  await assert.rejects(liveUsdtPairs(makeCtx({ okx }), CALL), /instruments|pairs/);
});

test('todaySplit throws when OKX names no live USDT spot pairs, never skips with the no-loss sentence', async () => {
  const okx = fakeExchange({ ...LOSING, instruments: [] });
  await assert.rejects(todaySplit(makeCtx({ okx }), CALL, plan), /instruments|pairs/);
});

// Review finding (today.mjs:17, probe P4): a balance reply with no details array anywhere must never read as an
// account holding nothing at all.
test('todaySplit throws when the account balance reply has no readable details array, never reads it as empty', async () => {
  const real = fakeExchange(LOSING);
  const okx = {
    ...real,
    json: async (args, call) => (args[0] === 'account' && args[1] === 'balance'
      ? { env: 'live', profile: call.profile || null, data: [{ totalEq: '2900' }] }
      : real.json(args, call)),
  };
  await assert.rejects(todaySplit(makeCtx({ okx }), CALL, plan), /account balance/);
});
