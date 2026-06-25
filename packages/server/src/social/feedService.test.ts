import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedService } from './feedService.ts';

test('forFriends returns only friends events, newest first, capped', () => {
  const feed = new FeedService();
  feed.recordWin('a', 'Ana', 1000, 1);
  feed.recordWin('b', 'Beni', 2000, 2);
  feed.recordWin('a', 'Ana', 3000, 3); // newest
  feed.recordWin('c', 'Cami', 4000, 4); // not a friend

  const rows = feed.forFriends(new Set(['a', 'b']));
  assert.deepEqual(rows.map((r) => `${r.userId}:${r.amountCents}`), ['a:3000', 'b:2000', 'a:1000']);
  assert.ok(rows.every((r) => r.kind === 'win'));

  // A non-friend's win is excluded.
  assert.equal(feed.forFriends(new Set(['x'])).length, 0);
  // limit is honoured.
  assert.equal(feed.forFriends(new Set(['a', 'b']), 1).length, 1);
});

test('the ring is bounded (oldest dropped past max)', () => {
  const feed = new FeedService(2);
  feed.recordWin('a', 'A', 1, 1);
  feed.recordWin('a', 'A', 2, 2);
  feed.recordWin('a', 'A', 3, 3); // drops the first
  const rows = feed.forFriends(new Set(['a']), 10);
  assert.deepEqual(rows.map((r) => r.amountCents), [3, 2]);
});
