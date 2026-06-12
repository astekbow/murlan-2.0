import { test } from 'vitest';
import assert from 'node:assert/strict';
import { wentOutSeat } from './finish.ts';

test('wentOutSeat returns the newly-appended finisher', () => {
  assert.equal(wentOutSeat([], [2]), 2);
  assert.equal(wentOutSeat([2], [2, 0]), 0);
  assert.equal(wentOutSeat([2, 0], [2, 0, 3]), 3);
});

test('wentOutSeat returns null when the order did not grow', () => {
  assert.equal(wentOutSeat([2, 0], [2, 0]), null);
  assert.equal(wentOutSeat([], []), null);
  // A shorter/reset next (e.g. a new game) is not a "went out" event.
  assert.equal(wentOutSeat([2, 0, 3], [1]), null);
});

test('wentOutSeat handles a multi-append defensively (returns the latest)', () => {
  assert.equal(wentOutSeat([1], [1, 0, 2]), 2);
});
