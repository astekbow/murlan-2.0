import test from 'node:test';
import assert from 'node:assert/strict';
import { TournamentMatchRegistry } from './tournamentMatchRegistry.ts';

test('pairings: markRunning dedups by (tid,round,index); clearPairing frees it', () => {
  const r = new TournamentMatchRegistry();
  assert.equal(r.isRunning('t1', 0, 0), false);
  r.markRunning('t1', 0, 0, 'room_a');
  assert.equal(r.isRunning('t1', 0, 0), true);
  assert.equal(r.isRunning('t1', 0, 1), false); // different index is independent
  assert.equal(r.isRunning('t2', 0, 0), false); // different tournament is independent
  r.clearPairing('t1', 0, 0);
  assert.equal(r.isRunning('t1', 0, 0), false);
});

test('no-show timer: fires after the delay; cancel stops it', async () => {
  const r = new TournamentMatchRegistry();
  const fired: string[] = [];
  r.armNoShow('room_a', 5, () => fired.push('a'));
  await new Promise((res) => setTimeout(res, 25));
  assert.deepEqual(fired, ['a']);

  r.armNoShow('room_b', 30, () => fired.push('b'));
  r.cancelNoShow('room_b');
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(fired, ['a']); // b cancelled, never fired

  r.cancelNoShow('room_x'); // cancel of an unknown room is safe
});
