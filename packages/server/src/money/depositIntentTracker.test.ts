import test from 'node:test';
import assert from 'node:assert/strict';
import { DepositIntentTracker } from './depositIntentTracker.ts';

test('hasOpen is true after open, false before', () => {
  let t = 1000;
  const tr = new DepositIntentTracker(() => t, 60_000);
  assert.equal(tr.hasOpen('u1'), false);
  tr.open('u1', 2000);
  assert.equal(tr.hasOpen('u1'), true);
});

test('intent expires after the TTL', () => {
  let t = 1000;
  const tr = new DepositIntentTracker(() => t, 60_000);
  tr.open('u1', 2000);
  t += 61_000;
  assert.equal(tr.hasOpen('u1'), false);
});

test('consume clears the intent', () => {
  let t = 1000;
  const tr = new DepositIntentTracker(() => t, 60_000);
  tr.open('u1', 2000);
  tr.consume('u1');
  assert.equal(tr.hasOpen('u1'), false);
});

test('matchByAmount finds open intents by declared amount (within tolerance)', () => {
  let t = 1000;
  const tr = new DepositIntentTracker(() => t, 60_000);
  tr.open('u1', 2000);
  tr.open('u2', 5000);
  assert.deepEqual(tr.matchByAmount(2000).map((i) => i.userId), ['u1']);
  assert.deepEqual(tr.matchByAmount(2001, 5).map((i) => i.userId), ['u1']); // tolerance
  assert.deepEqual(tr.matchByAmount(9999).map((i) => i.userId), []);
});

test('matchByAmount ignores zero-amount intents', () => {
  let t = 1000;
  const tr = new DepositIntentTracker(() => t, 60_000);
  tr.open('u1', 0);
  assert.deepEqual(tr.matchByAmount(0), []);
});
