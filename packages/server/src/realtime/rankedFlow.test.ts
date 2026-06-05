// ============================================================================
// MURLAN — Ranked gateway integration: a finished match moves MMR end-to-end.
// Proves the isolated post-settle hook (gateway.recordRankedResult) is wired and
// uses the live room seats, and that with NO active season it is a clean no-op.
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

async function harness(withSeason: boolean) {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const seasons = new InMemorySeasonRepository();
  const ranked = new RankedService(seasons, repo);
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1, // a single won game ends the match
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  // No money here — ranked must work for unstaked play too; provablyFair off to script the deal.
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, ranked, provablyFair: false });

  if (withSeason) await ranked.createSeason('Sezoni Test');

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });
  return {
    ranked, u1: u1.user.id, u2: u2.user.id, t1: u1.tokens.accessToken, t2: u2.tokens.accessToken, port,
    close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }),
  };
}

async function playOneMatch(h: { port: number; t1: string; t2: string }) {
  const c1: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.t1 }, transports: ['websocket'], forceNew: true });
  const c2: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.t2 }, transports: ['websocket'], forceNew: true });
  await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
  await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 0 });
  await emitAck(c2, 'room:join', { roomId: 'room_1' });
  const started = once(c1, 'game:start');
  await emitAck(c1, 'room:ready', true);
  await emitAck(c2, 'room:ready', true);
  await started;
  const end = once(c1, 'match:end');
  await emitAck(c1, 'game:play', { cards: [c('3', 'S')] }); // seat 0 plays its only card → wins
  await end;
  c1.close(); c2.close();
}

test('ranked: with an active season, finishing a match moves the winner up and the loser down', async () => {
  const h = await harness(true);
  try {
    await playOneMatch(h);
    // The MMR update is isolated/fire-and-forget; poll briefly for it to land.
    let winner = await h.ranked.getUserRanked(h.u1);
    for (let i = 0; i < 20 && winner.games === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      winner = await h.ranked.getUserRanked(h.u1);
    }
    const loser = await h.ranked.getUserRanked(h.u2);
    assert.equal(winner.rating, 1016);
    assert.equal(winner.wins, 1);
    assert.equal(winner.games, 1);
    assert.equal(loser.rating, 984);
    assert.equal(loser.games, 1);
  } finally {
    await h.close();
  }
});

test('ranked: with NO active season, finishing a match leaves MMR untouched (no-op)', async () => {
  const h = await harness(false);
  try {
    await playOneMatch(h);
    await new Promise((r) => setTimeout(r, 150)); // give any stray hook time to (not) fire
    const me = await h.ranked.getUserRanked(h.u1);
    assert.equal(me.season, null);
    assert.equal(me.rating, 1000);
    assert.equal(me.games, 0);
  } finally {
    await h.close();
  }
});
