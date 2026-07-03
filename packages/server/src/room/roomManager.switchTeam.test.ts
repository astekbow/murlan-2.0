// 2v2 squad picking: a waiting player can move to a free seat of the other team
// (the "Join Team 1 / Team 2" flow) instead of being auto-split. Owner request 2026-07-03.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from './roomManager.ts';

const u = (id: string) => ({ userId: id, username: id });

test('switchTeam moves a 2v2 player to a free seat of the other team and frees the old one', () => {
  const rm = new RoomManager();
  const created = rm.createRoom(u('A'), { type: '2v2', stakeCents: 0 });
  assert.ok(created.ok && created.roomId);
  const roomId = created.roomId!;
  assert.ok(rm.joinRoom(u('B'), roomId).ok); // A→seat0/team0, B→seat1/team1 (auto-fill)
  const before = rm.getRoom(roomId)!;
  assert.equal(before.seats[0]!.team, 0);
  assert.equal(before.seats[1]!.userId, 'B');
  assert.equal(before.seats[1]!.team, 1);

  const res = rm.switchTeam('B', 0);              // B joins team 0 → free team-0 seat (2)
  assert.equal(res.ok, true);
  const after = rm.getRoom(roomId)!;
  assert.equal(after.seats[1]!.userId, null, 'old seat vacated');
  assert.equal(after.seats[2]!.userId, 'B');
  assert.equal(after.seats[2]!.team, 0);
  assert.equal(after.seats[2]!.ready, false, 'moving un-readies you');
  assert.equal(after.seats[0]!.userId, 'A', 'the other player is untouched');

  assert.equal(rm.switchTeam('B', 0).ok, true, 'no-op when already on that team');
});

test('switchTeam refuses when the target team is full', () => {
  const rm = new RoomManager();
  const { roomId } = rm.createRoom(u('A'), { type: '2v2', stakeCents: 0 });
  rm.joinRoom(u('B'), roomId!);
  rm.joinRoom(u('C'), roomId!);
  rm.joinRoom(u('D'), roomId!); // full: team0 = A,C ; team1 = B,D
  const res = rm.switchTeam('A', 1);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error?.code, 'team_full');
});

test('switchTeam refuses outside a 2v2 room', () => {
  const rm = new RoomManager();
  const { roomId } = rm.createRoom(u('A'), { type: '1v1', stakeCents: 0 });
  rm.joinRoom(u('B'), roomId!);
  const res = rm.switchTeam('A', 1);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error?.code, 'not_2v2');
});
