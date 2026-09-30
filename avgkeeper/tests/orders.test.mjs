import { makeCtx, fakeExchange, notFound, CALL } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { OkxError } from '../scripts/runner.mjs';
import { buyClOrdId, placeArgs, sendBuy, readOrder, fillOf, stillOnTheBook } from '../scripts/orders.mjs';

const args100 = () => placeArgs({ instId: 'ETH-USDT', cents: 100, clOrdId: 'a1', code: '' });

test('the client id is reproducible, short and alphanumeric', () => {
  const a = buyClOrdId({ planId: 'p1', period: '2026-10-05', instId: 'ETH-USDT', profile: 't', demo: false });
  assert.match(a, /^ak[0-9a-f]{16}$/);
  assert.equal(a, buyClOrdId({ planId: 'p1', period: '2026-10-05', instId: 'ETH-USDT', profile: 't', demo: false }));
  assert.notEqual(a, buyClOrdId({ planId: 'p1', period: '2026-10-06', instId: 'ETH-USDT', profile: 't', demo: false }));
  assert.notEqual(a, buyClOrdId({ planId: 'p1', period: '2026-10-05', instId: 'ETH-USDT', profile: 't', demo: true }));
});

test('placeArgs is a cash market buy sized in USDT, with the code only when there is one', () => {
  const args = placeArgs({ instId: 'ETH-USDT', cents: 667, clOrdId: 'akx', code: '' });
  assert.deepEqual(args, ['spot', 'place', '--instId', 'ETH-USDT', '--side', 'buy', '--ordType', 'market', '--tdMode', 'cash', '--tgtCcy', 'quote_ccy', '--sz', '6.67', '--clOrdId', 'akx']);
  assert.deepEqual(placeArgs({ instId: 'ETH-USDT', cents: 667, clOrdId: 'akx', code: 'abc' }).slice(-2), ['--aiBuilderCode', 'abc']);
});

test('sendBuy reads an accepted order, a rejection and an unknown outcome', async () => {
  const ok = makeCtx({ okx: fakeExchange({ prices: { 'ETH-USDT': '1' } }) });
  assert.deepEqual(await sendBuy(ok, CALL, args100()), { accepted: true });
  const rej = makeCtx({ okx: fakeExchange({ placeReply: () => [{ sCode: '51008', sMsg: 'Insufficient balance' }] }) });
  assert.deepEqual(await sendBuy(rej, CALL, args100()), { rejected: { sCode: '51008', sMsg: 'Insufficient balance' } });
  const text = 'Error: [51008] Insufficient balance\nCode: 51008';
  const cliRej = makeCtx({ okx: fakeExchange({ placeReply: () => new OkxError(text, 'cli', text) }) });
  assert.equal((await sendBuy(cliRej, CALL, args100())).rejected.sCode, '51008');
  const timeout = makeCtx({ okx: fakeExchange({ placeReply: () => new OkxError('okx spot place timed out', 'timeout') }) });
  assert.ok((await sendBuy(timeout, CALL, args100())).unknown);
  const busy = makeCtx({ okx: fakeExchange({ placeReply: () => [{ sCode: '50001', sMsg: 'busy' }] }) });
  assert.ok((await sendBuy(busy, CALL, args100())).unknown);
  const timedOutOrder = makeCtx({ okx: fakeExchange({ placeReply: () => [{ sCode: '51149', sMsg: 'order timed out, please try again later' }] }) });
  assert.ok((await sendBuy(timedOutOrder, CALL, args100())).unknown);
});

// Review finding (orders.mjs:41): the ambiguous-code check on the CLI stderr path (spot_place_order's own
// normalizeWrite failures, distinct from the JSON-row path the cases above cover) was unpinned: a mutant that
// treats every CLI code as a rejection, ambiguous or not, survived the full suite.
test('sendBuy reports unknown, never a rejection, for an ambiguous code on the CLI stderr path', async () => {
  for (const code of ['50001', '503', '51149']) {
    const text = `Error: [${code}] busy\nCode: ${code}`;
    const cli = makeCtx({ okx: fakeExchange({ placeReply: () => new OkxError(text, 'cli', text) }) });
    const r = await sendBuy(cli, CALL, args100());
    assert.ok(r.unknown, `code ${code}: ${JSON.stringify(r)}`);
    assert.ok(!r.rejected, `code ${code}: ${JSON.stringify(r)}`);
  }
});

test('sendBuy reports unknown, never accepted, when OKX sends no order result', async () => {
  const empty = makeCtx({ okx: fakeExchange({ placeReply: () => [] }) });
  assert.deepEqual(await sendBuy(empty, CALL, args100()), { unknown: 'OKX sent no order result' });
  const noCode = makeCtx({ okx: fakeExchange({ placeReply: () => [{}] }) });
  assert.deepEqual(await sendBuy(noCode, CALL, args100()), { unknown: 'OKX sent no order result' });
});

// Review finding (orders.mjs:33): sCode null or '' is not proof OKX rejected the order, only that it sent no
// usable code at all (the same as sCode undefined, already unknown above). The order may have landed; only a
// read-back can say.
test('sendBuy reports unknown, never a rejection, when sCode is null or blank', async () => {
  const nullCode = makeCtx({ okx: fakeExchange({ placeReply: () => [{ sCode: null, sMsg: '' }] }) });
  assert.deepEqual(await sendBuy(nullCode, CALL, args100()), { unknown: 'OKX sent no order result' });
  const blankCode = makeCtx({ okx: fakeExchange({ placeReply: () => [{ sCode: '', sMsg: '' }] }) });
  assert.deepEqual(await sendBuy(blankCode, CALL, args100()), { unknown: 'OKX sent no order result' });
  const blankTrim = makeCtx({ okx: fakeExchange({ placeReply: () => [{ sCode: '  ', sMsg: '' }] }) });
  assert.deepEqual(await sendBuy(blankTrim, CALL, args100()), { unknown: 'OKX sent no order result' });
});

test('readOrder: a row, not found, or an error', async () => {
  const ctx = makeCtx({ okx: fakeExchange({ getReply: (id) => (id === 'x' ? notFound() : { state: 'filled', fillSz: '1', avgPx: '2' }) }) });
  assert.deepEqual(await readOrder(ctx, CALL, { instId: 'ETH-USDT', clOrdId: 'x' }), { notFound: true });
  assert.equal((await readOrder(ctx, CALL, { instId: 'ETH-USDT', clOrdId: 'y' })).row.state, 'filled');
  const net = makeCtx({ okx: fakeExchange({ getReply: () => new OkxError('Error: Failed to call OKX endpoint', 'network') }) });
  assert.equal((await readOrder(net, CALL, { instId: 'ETH-USDT', clOrdId: 'z' })).network, true);
});

// Review finding (orders.mjs:41): readOrder's network flag also covers a rate limit and a timeout ("worth reading
// again later, none is an answer"), each worth reading again the same way; only kind 'network' itself was tested.
for (const kind of ['rate', 'timeout']) {
  test(`readOrder reads a ${kind} failure as network too: worth reading again later`, async () => {
    const ctx = makeCtx({ okx: fakeExchange({ getReply: () => new OkxError(`Error: ${kind}`, kind) }) });
    const r = await readOrder(ctx, CALL, { instId: 'ETH-USDT', clOrdId: 'x' });
    assert.equal(r.network, true, JSON.stringify(r));
  });
}

// New regression (orders.mjs:59): an ambiguous OKX server code (50001, 50013, a 5xx) on the read-back of an
// accepted buy is a transient answer runner.mjs's own ambiguousCode already treats as worth reading again, the
// same as a network failure, a rate limit or a timeout. Reading it as a plain, non-retryable error halts the plan
// for good (settle() only reads readOrder's own `got.row` when `got.network` is false) over a reply that answers
// filled the moment it is read again.
for (const code of ['50001', '50013', '503']) {
  test(`readOrder reads an ambiguous OKX code (${code}) as network too: worth reading again later`, async () => {
    const text = `Error: Systems are busy, please try again later\nCode: ${code}`;
    const ctx = makeCtx({ okx: fakeExchange({ getReply: () => new OkxError(text, 'cli', text) }) });
    const r = await readOrder(ctx, CALL, { instId: 'ETH-USDT', clOrdId: 'x' });
    assert.equal(r.network, true, JSON.stringify(r));
  });
}

// Seen live on the owner's hourly demo plan, 2026-09-28 09:05: the APT-USDT read-back answered OKX's 50004
// "API endpoint request timeout." and the build then installed (930cfb7) halted the plan for good; the order had
// filled (0.3771 APT at 0.822). The text is the okx CLI 1.4.6's own stderr shape (dist/index.js: "Error:", then
// "Code:", "TraceId:", "Hint:" and "Version:" lines), so the check reads the Code line the way the real CLI writes it.
test('readOrder reads the live 50004 request timeout, in the real CLI stderr shape, as worth reading again', async () => {
  const text = 'Error: API endpoint request timeout. \nCode: 50004\nTraceId: 0a1b2c\nHint: Endpoint request timeout. Retry later.\nVersion: @okx_ai/okx-trade-cli@1.4.6';
  const ctx = makeCtx({ okx: fakeExchange({ getReply: () => new OkxError(text, 'cli', text) }) });
  const r = await readOrder(ctx, CALL, { instId: 'APT-USDT', clOrdId: 'ak43ed64c806491fa8' });
  assert.equal(r.network, true, JSON.stringify(r));
});

test('fillOf never counts an unreadable fill as zero', () => {
  assert.deepEqual(fillOf({ state: 'filled', accFillSz: '0.5', avgPx: '2' }), { kind: 'filled', notional: 1 });
  assert.equal(fillOf({ state: 'filled', accFillSz: '', avgPx: '2' }).kind, 'unreadable');
  assert.equal(fillOf({ state: 'filled', accFillSz: '1', avgPx: '' }).kind, 'unreadable');
  assert.equal(stillOnTheBook({ state: 'live' }), true);
  assert.equal(stillOnTheBook({ state: 'filled' }), false);
});

// Review finding (orders.mjs:93, should): state 'filled' with accFillSz '0' contradicts itself; OKX's own final
// states never fill nothing but 'canceled' or 'mmp_canceled'. Picking accFillSz over state (or the reverse) checks
// one field without checking it against the other (rule 2). Read as unreadable, so settleVerdict halts, instead of
// a confident buy_rejected ("the order finished without filling").
test('fillOf reads a "filled" row with accFillSz 0 as unreadable, never as a clean rejection', () => {
  assert.deepEqual(fillOf({ state: 'filled', accFillSz: '0', avgPx: '1767.30' }), { kind: 'unreadable', why: 'it reads as filled with a filled size of 0' });
  // A cancelled order filling nothing is ordinary and stays 'none'.
  assert.deepEqual(fillOf({ state: 'canceled', accFillSz: '0', avgPx: '' }), { kind: 'none' });
  assert.deepEqual(fillOf({ state: 'mmp_canceled', accFillSz: '0', avgPx: '' }), { kind: 'none' });
});

// Mutation review (2026-09-28): SURVIVED orders-fill-zero (read()'s NaN for an unreadable value mutated to 0).
// A genuinely unreadable accFillSz (blank, not the digit '0') must stay 'unreadable' even for a canceled order,
// never fall through to 'none' the way a real zero legitimately does for that state.
test('fillOf never reads a blank accFillSz as a real zero, even for a state that legitimately fills nothing', () => {
  assert.deepEqual(fillOf({ state: 'canceled', accFillSz: '', avgPx: '' }), { kind: 'unreadable', why: 'its filled size reads ""' });
  assert.deepEqual(fillOf({ state: 'mmp_canceled', accFillSz: undefined, avgPx: '' }), { kind: 'unreadable', why: 'its filled size reads null' });
});

// Review finding (orders.mjs:86, later): read() treated only undefined, null and '' as unreadable; a whitespace-
// only string, or a shape like '0x0' that JavaScript's Number() still parses, became 0 the same way a real zero
// does. A canceled order can have partly filled, so recording nothing spent from a value this shape is not proven.
test('fillOf never reads a whitespace-only or non-decimal accFillSz as a real zero either', () => {
  assert.equal(fillOf({ state: 'canceled', accFillSz: ' ', avgPx: '' }).kind, 'unreadable');
  assert.equal(fillOf({ state: 'canceled', accFillSz: '0x0', avgPx: '' }).kind, 'unreadable');
  assert.equal(fillOf({ state: 'filled', accFillSz: '0.5', avgPx: ' ' }).kind, 'unreadable');
});

// Review finding (buy.mjs:212): a row with no state, or a state OKX never documents as final, is not proof the
// order is finished. Only OKX's own final states ('filled', 'canceled', 'mmp_canceled') let fillOf read a size at
// all; anything else is 'pending', the same as a row still on the book, so settle() waits and reads it again.
test('fillOf treats a missing or undocumented state as pending, never as a finished order with nothing filled', () => {
  assert.deepEqual(fillOf({ accFillSz: '0', avgPx: '' }), { kind: 'pending' });
  assert.deepEqual(fillOf({ state: '', accFillSz: '0', avgPx: '' }), { kind: 'pending' });
  assert.deepEqual(fillOf({ state: 'some_future_state', accFillSz: '0', avgPx: '' }), { kind: 'pending' });
  // A non-zero accFillSz under an unknown state is not a confirmed fill either: still pending, never a premature
  // notional.
  assert.deepEqual(fillOf({ accFillSz: '0.5', avgPx: '2' }), { kind: 'pending' });
  assert.deepEqual(fillOf({ state: 'canceled', accFillSz: '0', avgPx: '' }), { kind: 'none' });
  assert.deepEqual(fillOf({ state: 'mmp_canceled', accFillSz: '0.1', avgPx: '2' }), { kind: 'filled', notional: 0.2 });
});

test('fillOf reads accFillSz, the accumulated total, never fillSz, the last fill only', () => {
  const r = fillOf({ state: 'filled', fillSz: '0.001', accFillSz: '0.00333', avgPx: '2000' });
  assert.equal(r.kind, 'filled');
  assert.ok(Math.abs(r.notional - 6.66) < 1e-9, `expected ~6.66, got ${r.notional}`);
});

test('fillOf returns pending for a row still on the book, before either size is read', () => {
  assert.deepEqual(fillOf({ state: 'live', accFillSz: 'not a number', avgPx: 'not a number' }), { kind: 'pending' });
  assert.deepEqual(fillOf({ state: 'partially_filled' }), { kind: 'pending' });
});
