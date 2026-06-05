// ============================================================================
// MURLAN — Ranked matchmaking integration: two players queue → auto-matched →
// seated into a fresh ranked room → match starts → MMR moves. Exercises the full
// server-driven seating path (no manual room:create/join), reusing the normal
// room lifecycle.
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
import { InMemorySeasonRepository } from '../ranked/seasonRepository.ts';
import { RankedService } from '../ranked/rankedService.ts';
import { MatchmakingService } from './matchmaking.ts';

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

test('ranked queue: two players are matched, seated, and the match auto-starts (and MMR moves)', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const seasons = new InMemorySeasonRepository();
  const ranked = new RankedService(seasons, repo);
  const matchmaking = new MatchmakingService();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1, // one won game ends the match
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, ranked, matchmaking, provablyFair: false });
  await ranked.createSeason('Sezoni Test');

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });

  const c1: any = ioClient(`http://localhost:${port}`, { auth: { token: u1.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  const c2: any = ioClient(`http://localhost:${port}`, { auth: { token: u2.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);

    // First player queues and waits (no match yet). Register the status listener
    // BEFORE joining — the server emits the update right after the ack.
    const update1P = once<any>(c1, 'ranked:queue:update');
    const q1 = await emitAck<any>(c1, 'ranked:queue:join', { matchType: '1v1' });
    assert.equal(q1.ok, true);
    const update1 = await update1P;
    assert.equal(update1.inQueue, true);
    assert.equal(update1.needed, 2);

    // Arm the started listeners BEFORE the second player joins (which triggers the match).
    const start1 = once(c1, 'game:start');
    const start2 = once(c2, 'game:start');
    const q2 = await emitAck<any>(c2, 'ranked:queue:join', { matchType: '1v1' });
    assert.equal(q2.ok, true);

    const [s1] = await Promise.all([start1, start2]); // both got dealt in → matched + started
    assert.equal(s1.hand.length, 1); // 1v1 scripted deal

    // The match is rated: seat-0 (the anchor / first queuer) holds 3♠ and wins.
    const end = once(c1, 'match:end');
    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] });
    await end;

    let winner = await ranked.getUserRanked(u1.user.id);
    for (let i = 0; i < 20 && winner.games === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      winner = await ranked.getUserRanked(u1.user.id);
    }
    const loser = await ranked.getUserRanked(u2.user.id);
    assert.equal(winner.rating, 1016);
    assert.equal(loser.rating, 984);

    // Ranked rooms never appear in the public lobby.
    assert.equal(rooms.listLobby().rooms.length, 0);
  } finally {
    c1.close(); c2.close();
    io.close();
    await new Promise<void>((res) => httpServer.close(() => res()));
  }
});
