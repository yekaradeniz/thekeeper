// avgkeeper/tests/decimal.test.mjs
import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { num, usd, pct } from '../scripts/units.mjs';
import { dec, cmpDec, sizeFromQuote, toCents, centsStr } from '../scripts/decimal.mjs';

test('num never invents a number', () => {
  assert.equal(num('1.5'), 1.5);
  assert.equal(num('-0.0411868607622643'), -0.0411868607622643);
  assert.equal(num('1e-5'), 0.00001);
  for (const v of ['', undefined, null, 'abc', '1,5', NaN, Infinity]) assert.ok(Number.isNaN(num(v)), String(v));
});

test('usd and pct print ? for an unreadable value', () => {
  assert.equal(usd(6.666), '6.67');
  assert.equal(usd(NaN), '?');
  assert.equal(pct(-0.1099), '-10.99');
  assert.equal(pct(NaN), '?');
});

test('toCents reads at most two decimals and refuses anything else', () => {
  assert.equal(toCents('10'), 1000);
  assert.equal(toCents('10.5'), 1050);
  assert.equal(toCents('0.07'), 7);
  for (const v of ['10.123', '-1', '1e2', '', ' 10', 10]) assert.equal(toCents(v), null, String(v));
});

test('centsStr writes two decimals', () => {
  assert.equal(centsStr(667), '6.67');
  assert.equal(centsStr(5), '0.05');
  assert.equal(centsStr(1000), '10.00');
});

test('sizeFromQuote floors to the lot size with exact arithmetic', () => {
  const inst = { lotSz: '0.00000001' };
  assert.equal(sizeFromQuote('6.67', '1767.30', inst), '0.00377411');
  assert.equal(sizeFromQuote('1', '84000', { lotSz: '0.00001' }), '0.00001');
  assert.equal(sizeFromQuote('0.50', '84000', { lotSz: '0.00001' }), '0.00000');
  assert.equal(sizeFromQuote('abc', '1', inst), null);
});

test('cmpDec compares across scales', () => {
  assert.equal(cmpDec(dec('0.00001'), dec('0.000010')), 0);
  assert.equal(cmpDec(dec('0.00000'), dec('0.00001')), -1);
});
