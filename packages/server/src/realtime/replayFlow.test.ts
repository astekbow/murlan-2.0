// ============================================================================
// MURLAN — Move-log gateway integration: a played match is recorded for replay.
// Proves the isolated, fire-and-forget recordAction hook captures applied moves
// in turn order through the real socket flow, keyed by the live match id.
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
import { InMemoryMatchActions } from './matchActions.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

function once<T = any>(socket: any, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function emitAck<T = any>(socket: any, event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => socket.emit(event, ...args, (r: T) => resolve(r)));
}

test('move-log: a finished match records each applied move in turn order, keyed by match id', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const matchLog = new InMemoryMatchActions();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1, // a single won game ends the match
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, matchLog, provablyFair: false });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });

  const c1: any = ioClient(`http://localhost:${port}`, { auth: { token: u1.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  const c2: any = ioClient(`http://localhost:${port}`, { auth: { token: u2.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 0 });
    await emitAck(c2, 'room:join', { roomId: 'room_1' });
    const started = once(c1, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await started;

    const matchId = rooms.matchIdOf('room_1');
    assert.ok(matchId, 'match id assigned');

    const end = once(c1, 'match:end');
    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] }); // seat 0 plays its only card → wins
    await end;

    // The recording is fire-and-forget; poll briefly for it to land.
    let log = await matchLog.listByMatch(matchId!);
    for (let i = 0; i < 20 && log.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      log = await matchLog.listByMatch(matchId!);
    }
    assert.equal(log.length, 1);            // only seat 0 acted (its play ended the match)
    assert.equal(log[0]!.seq, 0);
    assert.equal(log[0]!.seat, 0);
    assert.equal(log[0]!.gameIndex, 0);
    assert.equal(log[0]!.type, 'play');
    assert.deepEqual(log[0]!.cards, [c('3', 'S')]);
  } finally {
    c1.close(); c2.close();
    io.close();
    await new Promise<void>((res) => httpServer.close(() => res()));
  }
});
