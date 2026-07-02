// ============================================================================
// MURLAN — ASYNC bot path gateway integration (worker-pool decisions).
// Mirrors practiceFlow.test.ts but INJECTS a real BotWorkerPool, so the bot's
// move is computed on a worker thread and applied through applyDecidedBotMove's
// re-validation. Proves the full async pipeline end-to-end: schedule → worker
// decide → re-validate turn → apply → match completes — the production path on
// a multi-core host.
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
import { BotWorkerPool } from '../bot/botWorkerPool.ts';
import { GameGateway } from './gateway.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

function once<T = any>(socket: any, event: string, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (d: T) => { clearTimeout(t); resolve(d); });
  });
}
function emitAck<T = any>(socket: any, event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => socket.emit(event, ...args, (r: T) => resolve(r)));
}
function waitFor<T = any>(states: T[], pred: (s: T) => boolean, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = states.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waitFor state'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('async bots: a worker-pool decision drives the bot and the match completes', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1,
    // Seat 0 (human) opens the 3♠; seat 1 (bot) must respond via the WORKER path.
    dealerFactory: () => () => [[c('3', 'S'), c('6', 'S')], [c('4', 'S'), c('5', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  const pool = new BotWorkerPool(1);
  // botDelayMs pinned for speed + the pool injected → the ASYNC path is exercised.
  new GameGateway(io, rooms, auth, { countdownMs: 20, turnMs: 5_000, provablyFair: false, botDelayMs: 1, botPool: pool });
  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u = await auth.register({ username: 'human', email: 'h@h.com', password: 'password1' });

  const cli: any = ioClient(`http://localhost:${port}`, { auth: { token: u.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const states: any[] = [];
    cli.on('game:state', (s: any) => states.push(s));

    const started = once(cli, 'game:start');
    const res = await emitAck(cli, 'practice:start', { type: '1v1', tier: 'hard' });
    assert.equal(res.ok, true);
    await started;

    // Human opens with the 3♠; the bot's response is computed on the worker thread.
    await emitAck(cli, 'game:play', { cards: [c('3', 'S')] });
    const botMove = await waitFor(states, (s) => s.pile !== null && s.pile.cards[0].rank !== '3');
    assert.ok(['4', '5'].includes(botMove.pile.cards[0].rank), 'the bot responded via the async path');

    // Human goes out → the match settles exactly as on the sync path.
    const end = once(cli, 'match:end');
    await emitAck(cli, 'game:play', { cards: [c('6', 'S')] });
    const result = await end;
    assert.ok(result.winnerSeats.includes(0), 'the human (seat 0) won');
  } finally {
    cli.close();
    await pool.shutdown();
    await new Promise<void>((res) => { io.close(); httpServer.close(() => res()); });
  }
});
