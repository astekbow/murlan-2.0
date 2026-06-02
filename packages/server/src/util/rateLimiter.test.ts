import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rateLimiter.ts';

test('allows up to capacity then blocks until refill', () => {
  let now = 1000;
  const rl = new RateLimiter(3, 1, () => now); // 3 burst, 1 token/sec
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), false); // bucket empty

  now += 1000; // +1s -> 1 token
  assert.equal(rl.allow('s'), true);
  assert.equal(rl.allow('s'), false);
});

test('refill is capped at capacity and keys are independent', () => {
  let now = 0;
  const rl = new RateLimiter(2, 5, () => now);
  rl.allow('a');
  rl.allow('a'); // a empty
  now += 10_000; // long wait, but capped at capacity 2
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('a'), false);
  // a different key has its own full bucket
  assert.equal(rl.allow('b'), true);
});
