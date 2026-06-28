import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MoveLogSequencer } from './moveLogSequencer.ts';

test('next is monotonic per match starting at 0', () => {
  const s = new MoveLogSequencer();
  assert.equal(s.next('m1'), 0);
  assert.equal(s.next('m1'), 1);
  assert.equal(s.next('m1'), 2);
});

test('counters are independent per matchId', () => {
  const s = new MoveLogSequencer();
  assert.equal(s.next('m1'), 0);
  assert.equal(s.next('m2'), 0); // m2 starts fresh, not affected by m1
  assert.equal(s.next('m1'), 1);
  assert.equal(s.next('m2'), 1);
});

test('drop releases a finished match so its id can restart from 0', () => {
  const s = new MoveLogSequencer();
  s.next('m1'); // 0
  s.next('m1'); // 1
  s.drop('m1');
  assert.equal(s.next('m1'), 0); // counter was dropped → restarts
});
