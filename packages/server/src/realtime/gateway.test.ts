import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import type { Card } from '@murlan/engine';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { RoomManager } from '../room/roomManager.ts';
import { GameGateway } from './gateway.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

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

interface Harness {
  port: number;
  rooms: RoomManager;
  tokens: { t1: string; t2: string };
  close: () => Promise<void>;
}

async function harness(opts: { startTarget: number; scripts: Card[][][]; turnMs?: number; handPauseMs?: number }): Promise<Harness> {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const tokenSvc = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokenSvc);
  const rooms = new RoomManager({
    startTarget: opts.startTarget,
    dealerFactory: scripted(opts.scripts),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: opts.turnMs ?? 5_000, provablyFair: false, handPauseMs: opts.handPauseMs ?? 0 });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;

  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });

  return {
    port,
    rooms,
    tokens: { t1: u1.tokens.accessToken, t2: u2.tokens.accessToken },
    close: () =>
      new Promise<void>((res) => {
        io.close();
        httpServer.close(() => res());
      }),
  };
}

function connect(port: number, token: string): any {
  return ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
}

function once<T = any>(socket: any, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

function emitAck<T = any>(socket: any, event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => socket.emit(event, ...args, (res: T) => resolve(res)));
}

const ranksOf = (hand: Card[]) => hand.map((x) => (x.kind === 'standard' ? x.rank : `J-${x.color}`)).sort();

// ============================================================================
test('rejects a socket connection without a valid token', async () => {
  const h = await harness({ startTarget: 1, scripts: [[[c('3', 'S')], [c('4', 'S')]]] });
  try {
    const bad = ioClient(`http://localhost:${h.port}`, { auth: { token: 'garbage' }, transports: ['websocket'], forceNew: true });
    const errEvent = await once(bad, 'connect_error');
    assert.match(String((errEvent as any).message), /unauthorized/);
    bad.close();
  } finally {
    await h.close();
  }
});

test('full flow: create -> join -> ready -> match start; each player gets ONLY their own hand', async () => {
  const h = await harness({ startTarget: 1, scripts: [[[c('3', 'S')], [c('4', 'S')]]] });
  const c1 = connect(h.port, h.tokens.t1);
  const c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);

    const created = await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1000 });
    assert.ok(created.ok);
    assert.equal(created.roomId, 'room_1');
    const joined = await emitAck(c2, 'room:join', { roomId: 'room_1' });
    assert.ok(joined.ok);

    const start1 = once(c1, 'game:start');
    const start2 = once(c2, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    const [g1, g2] = await Promise.all([start1, start2]);

    // Privacy: creator is seat 0 with the 3♠; the opponent is seat 1 with the 4♠.
    assert.equal(g1.yourSeat, 0);
    assert.deepEqual(ranksOf(g1.hand), ['3']);
    assert.equal(g2.yourSeat, 1);
    assert.deepEqual(ranksOf(g2.hand), ['4']);
    // Neither player's hand contains the other's card.
    assert.ok(!ranksOf(g1.hand).includes('4'));
    assert.ok(!ranksOf(g2.hand).includes('3'));

    // seat 0 opens with the 3♠ (mandatory), empties its hand, and wins the match.
    const end2 = once(c2, 'match:end');
    const gameEnd2 = once(c2, 'game:end');
    const played = await emitAck(c1, 'game:play', { cards: [c('3', 'S')] });
    assert.ok(played.ok);

    const ge = await gameEnd2;
    assert.deepEqual(ge.finishingOrder, [0, 1]);
    const me = await end2;
    assert.deepEqual(me.winnerSeats, [0]);
  } finally {
    c1.close();
    c2.close();
    await h.close();
  }
});

test('a play broadcasts public counts only (no opponent card identities)', async () => {
  const h = await harness({
    startTarget: 100, // keep the match going
    scripts: [[[c('3', 'S'), c('5', 'S')], [c('4', 'S'), c('6', 'S')]]],
  });
  const c1 = connect(h.port, h.tokens.t1);
  const c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1000 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });
    const start2 = once(c2, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await start2;

    const state2 = once(c2, 'game:state');
    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] }); // opening 3♠
    const pub = await state2;

    // Public state carries counts, the face-up pile, and turn — never hidden hands.
    assert.deepEqual(pub.handCounts, [1, 2]); // seat0 played one of its two cards
    assert.equal(pub.pile.type, 'single');
    assert.equal(pub.turn, 1);
    assert.ok(!('hand' in pub), 'public state must not carry a hand field');
  } finally {
    c1.close();
    c2.close();
    await h.close();
  }
});

test('the turn timer auto-resolves an idle turn (forced legal lead)', async () => {
  const h = await harness({
    startTarget: 100,
    turnMs: 80, // short, so the idle leader times out quickly
    scripts: [[[c('3', 'S'), c('5', 'S')], [c('4', 'S'), c('6', 'S')]]],
  });
  const c1 = connect(h.port, h.tokens.t1);
  const c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1000 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });

    // Wait for the game:state where the turn has advanced to seat 1 — i.e. the
    // server forced seat 0's idle lead (opening must include 3♠, the lowest
    // accepted single). Attached before readying so timing can't race us.
    const forcedState = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('turn timer never fired')), 3_000);
      c2.on('game:state', (s: any) => {
        if (s.turn === 1) {
          clearTimeout(t);
          c2.off('game:state');
          resolve(s);
        }
      });
    });

    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);

    const pub = await forcedState;
    assert.deepEqual(pub.handCounts, [1, 2]); // seat 0 was forced to play one card
    assert.equal(pub.turn, 1);
  } finally {
    c1.close();
    c2.close();
    await h.close();
  }
});

test('card-switch flow: winner is privately dealt their hand, returns a 3–10, next game starts with loser leading', async () => {
  const h = await harness({
    startTarget: 100,
    scripts: [
      [[c('3', 'S')], [c('4', 'S')]],   // game 1: seat 0 (creator) holds 3♠, wins
      [[c('5', 'S')], [c('6', 'S')]],   // game 2 deal (before the switch)
    ],
  });
  const c1 = connect(h.port, h.tokens.t1);
  const c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1000 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });

    const g1 = once(c1, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await g1;

    // Winner-to-be receives their pending hand + a return prompt after winning g1.
    const handPrompt = once(c1, 'game:hand');
    const loserHandPrompt = once(c2, 'game:hand'); // loser's hand is refreshed too
    const returnPrompt = new Promise<any>((resolve) => {
      c1.on('card:switch', (d: any) => { if (d.awaitingReturn && d.given === null) resolve(d); });
    });

    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] }); // win game 1

    const pend = await handPrompt;
    assert.deepEqual(ranksOf(pend.hand), ['5', '6']); // dealt 5♠ + auto-received loser's 6♠
    const loserPend = await loserHandPrompt;
    assert.deepEqual(ranksOf(loserPend.hand), []); // loser gave away its only card (6♠)
    const prompt = await returnPrompt;
    assert.equal(prompt.winner, 0);
    assert.equal(prompt.loser, 1);

    // Winner returns the 5♠; the next game begins with the loser (seat 1) leading.
    const g2a = once(c1, 'game:start');
    const g2b = once(c2, 'game:start');
    await emitAck(c1, 'game:switchGive', { card: c('5', 'S') });
    const [start1, start2] = await Promise.all([g2a, g2b]);

    assert.equal(start1.state.turn, 1);                 // loser leads game 2
    assert.deepEqual(ranksOf(start1.hand), ['6']);      // seat 0 kept 6♠ (returned 5♠)
    assert.deepEqual(ranksOf(start2.hand), ['5']);      // seat 1 lost 6♠, got 5♠ back
  } finally {
    c1.close();
    c2.close();
    await h.close();
  }
});

test('reconnection pushes a fresh private hand to the reconnecting socket only', async () => {
  const h = await harness({
    startTarget: 100,
    scripts: [[[c('3', 'S'), c('5', 'S')], [c('4', 'S'), c('6', 'S')]]],
  });
  const c1 = connect(h.port, h.tokens.t1);
  let c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1000 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });
    const start2 = once(c2, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await start2; // match underway

    // Drop player 2 and reconnect with the same token.
    c2.close();
    c2 = connect(h.port, h.tokens.t2);
    const resumed = await once(c2, 'game:start'); // fresh full state to this socket only
    assert.equal(resumed.yourSeat, 1);
    assert.deepEqual(ranksOf(resumed.hand), ['4', '6']); // seat 1's own cards, intact
  } finally {
    c1.close();
    c2.close();
    await h.close();
  }
});

const J = (color: 'red' | 'black'): Card => ({ kind: 'joker', color });

test('inter-hand pause: the next hand WAITS on the standings screen, then deals when all players tap Continue', async () => {
  // 2 hands to a target of 2. Hand 1: seat0 plays 3♠ and wins. Hand 2's deal gives the
  // LOSER (seat1) BOTH jokers → noSwap (skips the card-switch step), so the next deal
  // goes straight through the inter-hand pause gate. handPauseMs is large so the deal can
  // ONLY come from the Continue gate (not the timer) within the test window.
  const h = await harness({
    startTarget: 2,
    handPauseMs: 5_000,
    scripts: [
      [[c('3', 'S')], [c('4', 'S')]],            // hand 1
      [[c('3', 'S')], [J('red'), J('black')]],   // hand 2 deal: loser (seat1) holds both jokers → noSwap
    ],
  });
  const c1 = connect(h.port, h.tokens.t1);
  const c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 0 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });
    const s1 = once(c1, 'game:start');
    const s2 = once(c2, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await Promise.all([s1, s2]); // hand 1 dealt (gameIndex 0)

    const end1 = once(c1, 'game:end');
    const contState = once(c2, 'hand:continueState');
    let dealtEarly = false;
    c1.once('game:start', () => { dealtEarly = true; });

    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] }); // seat0 empties → hand 1 ends
    assert.equal((await end1).gameIndex, 0);
    const cs = await contState;
    assert.equal(cs.humans, 2);
    assert.deepEqual(cs.ready, []); // nobody has tapped Continue yet

    await new Promise((r) => setTimeout(r, 150)); // the 5s timer is nowhere near
    assert.equal(dealtEarly, false, 'hand 2 must NOT deal before players continue');

    // Both tap Continue → the gate releases EARLY (well before the 5s timer).
    const start2a = once(c1, 'game:start', 1_500);
    const start2b = once(c2, 'game:start', 1_500);
    c1.emit('game:continue');
    c2.emit('game:continue');
    const [g2a] = await Promise.all([start2a, start2b]);
    assert.equal(g2a.gameIndex, 1); // hand 2 dealt after both continued
  } finally {
    c1.close();
    c2.close();
    await h.close();
  }
});

test('inter-hand pause: auto-advances after the timer even if nobody taps Continue (never stuck)', async () => {
  // Same 2-hand setup, but a SHORT pause and NO Continue taps → the next hand must still
  // deal on the timer (a missing/AFK player can never freeze the table).
  const h = await harness({
    startTarget: 2,
    handPauseMs: 80,
    scripts: [
      [[c('3', 'S')], [c('4', 'S')]],
      [[c('3', 'S')], [J('red'), J('black')]],
    ],
  });
  const c1 = connect(h.port, h.tokens.t1);
  const c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 0 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });
    const s1 = once(c1, 'game:start');
    const s2 = once(c2, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await Promise.all([s1, s2]);

    const start2 = once(c1, 'game:start', 1_500); // hand 2 should arrive on the ~80ms timer
    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] });
    assert.equal((await start2).gameIndex, 1); // dealt without any Continue
  } finally {
    c1.close();
    c2.close();
    await h.close();
  }
});
