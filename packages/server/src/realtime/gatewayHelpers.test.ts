import test from 'node:test';
import assert from 'node:assert/strict';
import { pickGhostNames, GHOST_NAMES, isBot, BOT_PREFIX } from './gatewayHelpers.ts';

test('pickGhostNames returns DISTINCT human names, no robot tells', () => {
  const names = pickGhostNames(3);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3, 'distinct');
  for (const n of names) {
    assert.ok(GHOST_NAMES.includes(n), 'from the human-name pool');
    assert.ok(!/bot|robot|🤖/i.test(n), 'no robot tell');
  }
});

test('pickGhostNames excludes the human’s own name (case-insensitive)', () => {
  const target = GHOST_NAMES[0]!;
  const names = pickGhostNames(GHOST_NAMES.length, target.toUpperCase());
  assert.ok(!names.some((n) => n.toLowerCase() === target.toLowerCase()), 'never collides with the host name');
});

test('pickGhostNames clamps count to the pool and handles 0', () => {
  assert.equal(pickGhostNames(0).length, 0);
  assert.ok(pickGhostNames(999).length <= GHOST_NAMES.length);
});

test('isBot identifies the bot userId prefix', () => {
  assert.equal(isBot(`${BOT_PREFIX}room_1:1`), true);
  assert.equal(isBot('u_5'), false);
  assert.equal(isBot(null), false);
});
