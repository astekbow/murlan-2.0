import { test } from 'vitest';
import assert from 'node:assert/strict';
import { seatPosition } from './layout.ts';

test('1v1: I am bottom, opponent is top (regardless of my seat index)', () => {
  assert.equal(seatPosition(2, 0, 0), 'bottom');
  assert.equal(seatPosition(2, 0, 1), 'top');
  assert.equal(seatPosition(2, 1, 1), 'bottom');
  assert.equal(seatPosition(2, 1, 0), 'top');
});

test('1v1v1: I am bottom, next-in-turn top-right, the other top-left', () => {
  assert.equal(seatPosition(3, 0, 0), 'bottom');
  assert.equal(seatPosition(3, 0, 1), 'top-right');
  assert.equal(seatPosition(3, 0, 2), 'top-left');
  // rotation: if I sit at seat 2
  assert.equal(seatPosition(3, 2, 2), 'bottom');
  assert.equal(seatPosition(3, 2, 0), 'top-right');
  assert.equal(seatPosition(3, 2, 1), 'top-left');
});

test('2v2: partner is opposite (top); opponents are left and right', () => {
  assert.equal(seatPosition(4, 0, 0), 'bottom');
  assert.equal(seatPosition(4, 0, 1), 'right');
  assert.equal(seatPosition(4, 0, 2), 'top'); // partner (seats 0 & 2 are a team)
  assert.equal(seatPosition(4, 0, 3), 'left');
  // my partner sits opposite me from seat 1's perspective too
  assert.equal(seatPosition(4, 1, 3), 'top');
});
