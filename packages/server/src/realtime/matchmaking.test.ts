import test from 'node:test';
import assert from 'node:assert/strict';
import { MatchmakingService } from './matchmaking.ts';

const entry = (userId: string, rating: number, since: number, matchType: any = '1v1') =>
  ({ userId, username: userId.toUpperCase(), rating, matchType, since });

test('1v1: forms a 2-player group, removes it, then has nothing left', () => {
  const mm = new MatchmakingService();
  mm.enqueue(entry('a', 1000, 1));
  assert.equal(mm.formGroup('1v1'), null); // not enough yet
  mm.enqueue(entry('b', 1020, 2));
  const g = mm.formGroup('1v1')!;
  assert.equal(g.length, 2);
  assert.deepEqual(g.map((e) => e.userId).sort(), ['a', 'b']);
  assert.equal(mm.count('1v1'), 0);
  assert.equal(mm.formGroup('1v1'), null);
});

test('enqueue is idempotent per user (re-queue does not duplicate)', () => {
  const mm = new MatchmakingService();
  mm.enqueue(entry('a', 1000, 1));
  mm.enqueue(entry('a', 1000, 2));
  assert.equal(mm.count('1v1'), 1);
  assert.equal(mm.has('a'), true);
});

test('remove takes a player out of the queue', () => {
  const mm = new MatchmakingService();
  mm.enqueue(entry('a', 1000, 1));
  mm.enqueue(entry('b', 1000, 2));
  assert.equal(mm.remove('a'), true);
  assert.equal(mm.has('a'), false);
  assert.equal(mm.formGroup('1v1'), null); // only b left
});

test('the longest waiter anchors the group and gets the closest-rated partner', () => {
  const mm = new MatchmakingService();
  mm.enqueue(entry('old', 1500, 1));   // oldest → anchor
  mm.enqueue(entry('far', 1900, 2));
  mm.enqueue(entry('near', 1520, 3));  // closest to anchor
  const g = mm.formGroup('1v1')!;
  assert.deepEqual(g.map((e) => e.userId).sort(), ['near', 'old']);
  assert.equal(mm.count('1v1'), 1); // 'far' still waiting
  assert.equal(mm.has('far'), true);
});

test('a rating gap beyond tolerance prevents a match', () => {
  const mm = new MatchmakingService(200); // tight bracket
  mm.enqueue(entry('a', 1000, 1));
  mm.enqueue(entry('b', 1400, 2)); // 400 apart > 200
  assert.equal(mm.formGroup('1v1'), null);
});

test('1v1v1 needs 3 and 2v2 needs 4; queues are isolated per type', () => {
  const mm = new MatchmakingService();
  mm.enqueue(entry('a', 1000, 1, '1v1v1'));
  mm.enqueue(entry('b', 1000, 2, '1v1v1'));
  assert.equal(mm.formGroup('1v1v1'), null); // need 3
  mm.enqueue(entry('c', 1000, 3, '1v1v1'));
  assert.equal(mm.formGroup('1v1v1')!.length, 3);

  for (const u of ['w', 'x', 'y', 'z']) mm.enqueue(entry(u, 1000, 10, '2v2'));
  assert.equal(mm.formGroup('2v2')!.length, 4);
  assert.equal(mm.formGroup('1v1'), null); // unrelated type empty
});
