import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import { RoomManager } from './roomManager.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });
const U = (n: number) => ({ userId: `u${n}`, username: `user${n}` });

/** dealerFactory that always deals the given scripted hands (one game). */
function scripted(scripts: Card[][][]) {
  return (_n: 2 | 3 | 4) => {
    let i = 0;
    return () => {
      const h = scripts[Math.min(i, scripts.length - 1)]!;
      i += 1;
      return h.map((hand) => hand.map((card) => ({ ...card })));
    };
  };
}

function mgr(opts: Partial<ConstructorParameters<typeof RoomManager>[0]> = {}) {
  let n = 0;
  return new RoomManager({ idFactory: () => `room_${(n += 1)}`, ...opts });
}

// ---------- lobby & creation -------------------------------------------------
test('createRoom seats the creator and lists the room in the lobby', () => {
  const m = mgr();
  const r = m.createRoom(U(1), { type: '1v1', stakeCents: 1000 });
  assert.ok(r.ok);
  assert.equal(r.roomId, 'room_1');

  const lobby = m.listLobby();
  assert.equal(lobby.rooms.length, 1);
  assert.equal(lobby.rooms[0]!.seatsFilled, 1);
  assert.equal(lobby.rooms[0]!.seatsTotal, 2);

  const state = m.roomStateDTO('room_1')!;
  assert.equal(state.seats[0]!.userId, 'u1');
  assert.equal(state.status, 'waiting');
});

test('a user cannot be in two rooms at once', () => {
  const m = mgr();
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  const second = m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'already_in_room');
});

test('joining fills the room and flips status to ready; full rooms reject joiners', () => {
  const m = mgr();
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  assert.ok(m.joinRoom(U(2), 'room_1').ok);
  assert.equal(m.isFull('room_1'), true);
  assert.equal(m.roomStateDTO('room_1')!.status, 'ready');

  const late = m.joinRoom(U(3), 'room_1');
  assert.equal(late.ok, false);
  assert.equal(late.error?.code, 'room_unavailable');
});

test('joining a non-existent room errors', () => {
  const m = mgr();
  const r = m.joinRoom(U(1), 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, 'no_room');
});

// ---------- 2v2 team seating -------------------------------------------------
test('2v2 seats players into the requested teams (0 -> {0,2}, 1 -> {1,3})', () => {
  const m = mgr();
  m.createRoom(U(1), { type: '2v2', stakeCents: 500, team: 0 }); // seat 0
  m.joinRoom(U(2), 'room_1', 1); // seat 1
  m.joinRoom(U(3), 'room_1', 0); // seat 2
  m.joinRoom(U(4), 'room_1', 1); // seat 3

  const seats = m.roomStateDTO('room_1')!.seats;
  assert.deepEqual(seats.map((s) => s.userId), ['u1', 'u2', 'u3', 'u4']);
  assert.deepEqual(seats.map((s) => s.team), [0, 1, 0, 1]);
});

// ---------- ready check ------------------------------------------------------
test('allReady requires every seat filled and ready', () => {
  const m = mgr();
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  m.joinRoom(U(2), 'room_1');
  assert.equal(m.allReady('room_1'), false);
  m.setReady('u1', true);
  assert.equal(m.allReady('room_1'), false);
  m.setReady('u2', true);
  assert.equal(m.allReady('room_1'), true);
});

// ---------- match start, privacy & forwarding --------------------------------
test('startMatch deals game 1; private hands stay private, public state is counts-only', () => {
  const m = mgr({
    startTarget: 1,
    dealerFactory: scripted([[[c('3', 'S')], [c('4', 'S')]]]),
  });
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 }); // seat 0
  m.joinRoom(U(2), 'room_1');                            // seat 1
  m.setReady('u1', true);
  m.setReady('u2', true);
  assert.ok(m.startMatch('room_1').ok);

  assert.equal(m.roomStateDTO('room_1')!.status, 'inMatch');

  const pub = m.publicGameDTO('room_1')!;
  assert.equal(pub.turn, 0);                 // seat 0 holds 3♠ and leads
  assert.deepEqual(pub.handCounts, [1, 1]);  // counts only — no identities
  assert.ok(!('hand' in pub));

  // Private hands are accessible only via handOf (server -> that seat's socket).
  assert.deepEqual(m.handOf('room_1', 0)!.map((x) => (x.kind === 'standard' ? x.rank : 'J')), ['3']);
  assert.deepEqual(m.handOf('room_1', 1)!.map((x) => (x.kind === 'standard' ? x.rank : 'J')), ['4']);
});

test('play is forwarded to the Match and a finished match flips the room to finished', () => {
  const m = mgr({
    startTarget: 1,
    dealerFactory: scripted([[[c('3', 'S')], [c('4', 'S')]]]),
  });
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  m.joinRoom(U(2), 'room_1');
  m.setReady('u1', true);
  m.setReady('u2', true);
  m.startMatch('room_1');

  // Opening with a card that omits the 3♠ is rejected by the engine via the Match.
  // (seat 0 only holds 3♠, so we play it; it empties the hand and wins the match.)
  const r = m.play('u1', [c('3', 'S')]);
  assert.ok(r.ok);
  const ended = r.matchEvents.find((e) => e.kind === 'matchEnded') as any;
  assert.ok(ended);
  assert.deepEqual(ended.winnerSeats, [0]);
  assert.equal(m.roomStateDTO('room_1')!.status, 'finished');
});

test('acting in a room without an active match is rejected', () => {
  const m = mgr();
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  const r = m.play('u1', [c('3', 'S')]);
  assert.equal(r.ok, false);
});

// ---------- unique match id (no escrow collision on a reused room) -----------
test('assignMatchId issues a distinct id per match so a reused room cannot collide', () => {
  const m = mgr();
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  const id1 = m.assignMatchId('room_1');
  const id2 = m.assignMatchId('room_1');
  assert.ok(id1 && id2);
  assert.notEqual(id1, id2);
  assert.equal(m.matchIdOf('room_1'), id2);
  assert.notEqual(id1, 'room_1'); // never the bare room id
});

// ---------- leaving ----------------------------------------------------------
test('leaving frees the seat and closes a room once empty', () => {
  const m = mgr();
  m.createRoom(U(1), { type: '1v1', stakeCents: 100 });
  m.joinRoom(U(2), 'room_1');

  const leave2 = m.leaveRoom('u2');
  assert.equal(leave2.roomClosed, false);
  assert.equal(m.roomStateDTO('room_1')!.status, 'waiting'); // reverted from ready
  assert.equal(m.roomStateDTO('room_1')!.seats[1]!.userId, null);

  const leave1 = m.leaveRoom('u1');
  assert.equal(leave1.roomClosed, true);
  assert.equal(m.roomStateDTO('room_1'), null); // room gone
  assert.equal(m.listLobby().rooms.length, 0);
});
