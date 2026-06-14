// ============================================================================
// MURLAN — Free-lobby auto-fill ("ghost players").
// Proves: a FREE (zero-stake) lobby with a lone host auto-fills with a human-named
// fill-player (whose userId is REDACTED in the client frame, so it can't be unmasked),
// while a STAKED (real-money) lobby is NEVER auto-filled — the hard anti-fraud guard.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { RoomManager } from '../room/roomManager.ts';
import { GameGateway } from './gateway.ts';

function once<T = any>(socket: any, event: string, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const tm = setTimeout(() => reject(new Error(`timeout ${event}`)), timeoutMs);
    socket.once(event, (d: T) => { clearTimeout(tm); resolve(d); });
  });
}
const emitAck = <T = any>(socket: any, event: string, ...args: any[]): Promise<T> =>
  new Promise((resolve) => socket.emit(event, ...args, (r: T) => resolve(r)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function harness() {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({ idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })() });
  new GameGateway(io, rooms, auth, { countdownMs: 20, provablyFair: false, botDelayMs: 1, ghostFillMs: 40 });
  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u = await auth.register({ username: 'TheHost', email: 'h@h.com', password: 'password1' });
  return { port, token: u.tokens.accessToken, close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }) };
}

test('a FREE lobby with a lone host auto-fills with a human-named ghost (userId redacted)', async () => {
  const h = await harness();
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const states: any[] = [];
    cli.on('room:state', (s: any) => states.push(s));
    const res = await emitAck(cli, 'room:create', { type: '1v1', stakeCents: 0, team: 0 });
    assert.equal(res.ok, true);

    // Within the fill window, seat 1 gets occupied by a fill-player.
    await sleep(120);
    const filledState = states.find((s) => s.seats?.[1]?.username);
    assert.ok(filledState, 'the empty seat was auto-filled');
    const ghost = filledState.seats[1];
    assert.ok(ghost.username && ghost.username !== 'TheHost', 'ghost has its own name, not the host');
    assert.ok(!/bot|robot|🤖/i.test(ghost.username), 'ghost name has no robot tell');
    assert.equal(ghost.userId, null, 'ghost userId is REDACTED in the client frame (cannot be unmasked)');
    assert.equal(ghost.ready, true, 'ghost is ready so the host can start');
  } finally {
    cli.close();
    await h.close();
  }
});

test('GUARD: a STAKED (real-money) lobby is NEVER auto-filled with a ghost', async () => {
  const h = await harness();
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const states: any[] = [];
    cli.on('room:state', (s: any) => states.push(s));
    const res = await emitAck(cli, 'room:create', { type: '1v1', stakeCents: 1500, team: 0 });
    assert.equal(res.ok, true);

    // Wait well past the fill window — the staked room must stay one human, one empty seat.
    await sleep(150);
    assert.ok(!states.some((s) => s.seats?.[1]?.username), 'NO fill-player ever joined the staked room');
    const last = states[states.length - 1];
    assert.equal(last.seats.filter((x: any) => x.username).length, 1, 'still just the human host');
  } finally {
    cli.close();
    await h.close();
  }
});
