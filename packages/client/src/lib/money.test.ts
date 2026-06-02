import test from 'node:test';
import assert from 'node:assert/strict';
import { dollars, parseDollarsToCents, txLabel } from './money.ts';

test('dollars formats integer cents', () => {
  assert.equal(dollars(0), '$0.00');
  assert.equal(dollars(1800), '$18.00');
  assert.equal(dollars(2001), '$20.01');
});

test('parseDollarsToCents rounds to integer cents and rejects invalid/negative', () => {
  assert.equal(parseDollarsToCents('5'), 500);
  assert.equal(parseDollarsToCents('5.5'), 550);
  assert.equal(parseDollarsToCents('0.019'), 2); // rounds
  assert.equal(parseDollarsToCents(''), null);
  assert.equal(parseDollarsToCents('-3'), null);
  assert.equal(parseDollarsToCents('abc'), null);
});

test('txLabel maps known types and passes through unknown', () => {
  assert.equal(txLabel('deposit'), 'Depozitë');
  assert.equal(txLabel('payout'), 'Fitim');
  assert.equal(txLabel('weird'), 'weird');
});
