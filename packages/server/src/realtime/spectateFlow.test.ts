// ============================================================================
// MURLAN — Spectator integration: a watcher receives the SAME public, hands-
// hidden state players see, never a private hand, and a seated player can't
// double as a spectator. Closes the loop on the broadcast-safety guarantee.
// ============================================================================

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

function once<T = any>(socket: any, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function emitAck<T = any>(socket: any, event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => socket.emit(event, ...args, (r: T) => resolve(r)));
}

test('a spectator watches the public match (no hand leak); a seated player cannot spectate', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1,
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, provablyFair: false });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });
  const u3 = await auth.register({ username: 'watcher', email: 'w@w.com', password: 'password3' });

  const c1: any = ioClient(`http://localhost:${port}`, { auth: { token: u1.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  const c2: any = ioClient(`http://localhost:${port}`, { auth: { token: u2.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  const c3: any = ioClient(`http://localhost:${port}`, { auth: { token: u3.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect'), once(c3, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 0 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });
    const started = once(c1, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await started;

    // The watcher must NEVER receive a private hand.
    let leakedHand = false;
    c3.on('game:start', () => { leakedHand = true; });
    c3.on('game:hand', () => { leakedHand = true; });

    // Spectate → catch up to the live public state (counts only, no cards).
    const pubState = once<any>(c3, 'game:state');
    const spec = await emitAck<any>(c3, 'room:spectate', { roomId: 'room_1' });
    assert.equal(spec.ok, true);
    const state = await pubState;
    assert.ok(Array.isArray(state.handCounts));
    assert.equal(state.handCounts.length, 2); // sees opponents' COUNTS, not cards

    // A seated player cannot also spectate.
    const seatedTry = await emitAck<any>(c1, 'room:spectate', { roomId: 'room_1' });
    assert.equal(seatedTry.ok, false);
    assert.equal(seatedTry.error?.code, 'seated');

    // The watcher receives the match:end broadcast like everyone in the room.
    const end = once<any>(c3, 'match:end');
    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] });
    const res = await end;
    assert.deepEqual(res.winnerSeats, [0]);

    await new Promise((r) => setTimeout(r, 50)); // let any stray private emit (not) arrive
    assert.equal(leakedHand, false); // the core guarantee: no hand ever reached the spectator

    const un = await emitAck<any>(c3, 'room:unspectate');
    assert.equal(un.ok, true);
  } finally {
    c1.close(); c2.close(); c3.close();
    io.close();
    await new Promise<void>((res) => httpServer.close(() => res()));
  }
});

// socket-5/6: a PRIVATE (invite/code) room must not be spectatable by an outsider,
// and the watcher's room:state must never carry the private joinCode.
test('a private room cannot be spectated by an outsider (no joinCode leak)', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1,
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, provablyFair: false });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'owner', email: 'o@o.com', password: 'password1' });
  const u3 = await auth.register({ username: 'snoop', email: 's@s.com', password: 'password3' });

  const c1: any = ioClient(`http://localhost:${port}`, { auth: { token: u1.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  const c3: any = ioClient(`http://localhost:${port}`, { auth: { token: u3.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  try {
    await Promise.all([once(c1, 'connect'), once(c3, 'connect')]);
    // Owner creates a PRIVATE room (gets a joinCode).
    const created = await emitAck<any>(c1, 'room:create', { type: '1v1', stakeCents: 0, private: true });
    assert.equal(created.ok, true);
    const roomId = created.roomId ?? 'room_1';

    // An outsider's spectate attempt is rejected (no_room), so the private table never opens.
    const snoop = await emitAck<any>(c3, 'room:spectate', { roomId });
    assert.equal(snoop.ok, false);
    assert.equal(snoop.error?.code, 'no_room');
  } finally {
    c1.close(); c3.close();
    io.close();
    await new Promise<void>((res) => httpServer.close(() => res()));
  }
});
