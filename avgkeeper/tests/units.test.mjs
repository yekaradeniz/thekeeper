// avgkeeper/tests/units.test.mjs
import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usd, pct, sigPrice, num, isoMinute,
} from '../scripts/units.mjs';

test('usd and pct never print a signed zero', () => {
  assert.equal(usd(-0.001), '0.00');
  assert.equal(usd(-0), '0.00');
  assert.equal(pct(-0.00001), '0.00');
  assert.equal(pct(-0), '0.00');
  // a real negative amount still reads negative
  assert.equal(usd(-1.2), '-1.20');
  assert.equal(pct(-0.1), '-10.00');
});

test('sigPrice trims a price to at most 8 significant digits, decimal notation', () => {
  assert.equal(sigPrice('0.1432069633398415'), '0.14320696');
  assert.equal(sigPrice('43000.5'), '43000.5');
  assert.equal(sigPrice('84000.0'), '84000.0');
  assert.equal(sigPrice('0.00000841234567891'), '0.0000084123457');
});

test('num and isoMinute are unaffected (sanity)', () => {
  assert.ok(Number.isNaN(num('abc')));
  assert.equal(typeof isoMinute(Date.now()), 'string');
});
