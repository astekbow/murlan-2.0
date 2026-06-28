import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecentWinnersTicker } from './recentWinnersTicker.ts';

test('add pushes newest-first', () => {
  const t = new RecentWinnersTicker(8);
  t.add('alice', 1000, 1);
  t.add('bob', 2000, 2);
  const snap = t.snapshot();
  assert.equal(snap[0]!.username, 'bob'); // most recent first
  assert.equal(snap[1]!.username, 'alice');
});

test('ring is bounded to max (oldest drop off)', () => {
  const t = new RecentWinnersTicker(3);
  for (let i = 0; i < 5; i++) t.add(`u${i}`, 100, i);
  const snap = t.snapshot();
  assert.equal(snap.length, 3);
  assert.deepEqual(snap.map((w) => w.username), ['u4', 'u3', 'u2']); // newest 3 only
});

test('snapshot is a shallow copy (push/splice on it cannot corrupt the ring)', () => {
  // Matches the original gateway contract (recentWinners.slice()): the ARRAY is copied so the consumer
  // can't grow/shrink the ring; entries are serialized to the client immediately, so element identity
  // is not part of the contract.
  const t = new RecentWinnersTicker(8);
  t.add('alice', 1000, 1);
  const snap = t.snapshot();
  snap.push({ username: 'evil', amountCents: 9, at: 9 });
  snap.length = 0;
  const fresh = t.snapshot();
  assert.equal(fresh.length, 1); // the ring is unaffected by structural mutation of a snapshot
  assert.equal(fresh[0]!.username, 'alice');
});
