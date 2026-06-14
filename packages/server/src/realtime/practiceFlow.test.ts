// ============================================================================
// MURLAN — Practice-vs-bots gateway integration.
// Proves: practice:start fills a zero-stake room with a bot, the bot acts on its
// own turn (here it must LEAD the opening 3♠), the match plays to completion, and
// the practice room is hidden from the public lobby.
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
/** Resolve once any collected game:state satisfies `pred` (avoids attach races). */
function waitFor<T = any>(states: T[], pred: (s: T) => boolean, timeoutMs = 3_000): Promise<T> {
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

async function harness() {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1, // one won game ends the match
    // Seat 0 (human) holds 3♠ → leads + opens it; seat 1 (bot) must RESPOND. The
    // human then plays 6♠ and goes out to win — but only after the bot has acted.
    dealerFactory: () => () => [[c('3', 'S'), c('6', 'S')], [c('4', 'S'), c('5', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  // provablyFair off to script the deal; bots act near-instantly for a fast test.
  new GameGateway(io, rooms, auth, { countdownMs: 20, turnMs: 5_000, provablyFair: false, botDelayMs: 1 });
  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u = await auth.register({ username: 'human', email: 'h@h.com', password: 'password1' });
  return { port, token: u.tokens.accessToken, close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }) };
}

test('practice vs bots: a bot fills the table, leads the opening 3♠, and the match completes', async () => {
  const h = await harness();
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const states: any[] = [];
    cli.on('game:state', (s: any) => states.push(s));

    const started = once(cli, 'game:start');
    const res = await emitAck(cli, 'practice:start', { type: '1v1', tier: 'medium' });
    assert.equal(res.ok, true);

    const gs = await started; // the human's private deal
    assert.deepEqual(gs.hand.map((x: any) => `${x.rank}${x.suit}`).sort(), ['3S', '6S']);

    // The practice room must NOT appear in the public lobby or spectator list.
    const lobby = await emitAck(cli, 'lobby:list');
    assert.equal(lobby.rooms.length, 0, 'practice room hidden from lobby');
    assert.equal(lobby.live.length, 0, 'practice room hidden from spectators');

    // Human opens with the 3♠; the BOT must then respond on its own turn.
    await emitAck(cli, 'game:play', { cards: [c('3', 'S')] });
    const botMove = await waitFor(states, (s) => s.pile !== null && s.pile.cards[0].rank !== '3');
    assert.ok(['4', '5'].includes(botMove.pile.cards[0].rank), 'the bot responded with a higher single');

    // Human plays the 6♠, goes out → wins → the match ends.
    const end = once(cli, 'match:end');
    await emitAck(cli, 'game:play', { cards: [c('6', 'S')] });
    const result = await end;
    assert.ok(result.winnerSeats.includes(0), 'the human (seat 0) won the practice match');
  } finally {
    cli.close();
    await h.close();
  }
});
