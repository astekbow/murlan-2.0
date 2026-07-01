import test from 'node:test';
import assert from 'node:assert/strict';
import { pickGhostNames, GHOST_NAMES, isBot, BOT_PREFIX, pickFillTier } from './gatewayHelpers.ts';

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

test('pickFillTier maps the rng to the weighted difficulty bands (easy 20 / medium 40 / hard 40)', () => {
  assert.equal(pickFillTier(() => 0.0), 'easy');
  assert.equal(pickFillTier(() => 0.19), 'easy');
  assert.equal(pickFillTier(() => 0.2), 'medium');
  assert.equal(pickFillTier(() => 0.59), 'medium');
  assert.equal(pickFillTier(() => 0.6), 'hard');
  assert.equal(pickFillTier(() => 0.99), 'hard');
  // Over many draws all three tiers appear → a free table gets a real MIX, not an all-hard wall.
  const seen = new Set<string>();
  let seed = 1;
  const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 200; i += 1) seen.add(pickFillTier(rng));
  assert.deepEqual([...seen].sort(), ['easy', 'hard', 'medium']);
});
