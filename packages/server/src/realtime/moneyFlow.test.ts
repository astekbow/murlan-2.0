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
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryMatchesRepository } from '../money/matchesRepository.ts';
import { MoneyService } from '../money/moneyService.ts';
import { RateLimiter } from '../util/rateLimiter.ts';

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

interface Harness {
  port: number;
  wallet: WalletService;
  u1: string;
  u2: string;
  t1: string;
  t2: string;
  close: () => Promise<void>;
}

/** A staked 1v1 server with both players funded $10, seat 0 holding the 3♠.
 *  `gatewayOpts` overrides the gateway defaults (e.g. a short abandonMs or a tiny
 *  rate limiter) so timing/limit behaviour can be tested deterministically. */
async function staked1v1(
  startTarget: number,
  gatewayOpts: { abandonMs?: number; rateLimiter?: RateLimiter } = {},
): Promise<Harness> {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const money = new MoneyService(wallet, new InMemoryMatchesRepository());
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget,
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, money, rakeBps: 1_000, abandonMs: 60_000, provablyFair: false, ...gatewayOpts });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });
  await wallet.credit(u1.user.id, 1000, { type: 'deposit' });
  await wallet.credit(u2.user.id, 1000, { type: 'deposit' });

  return {
    port, wallet,
    u1: u1.user.id, u2: u2.user.id,
    t1: u1.tokens.accessToken, t2: u2.tokens.accessToken,
    close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }),
  };
}

async function startStakedMatch(h: Harness): Promise<{ c1: any; c2: any }> {
  const c1: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.t1 }, transports: ['websocket'], forceNew: true });
  const c2: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.t2 }, transports: ['websocket'], forceNew: true });
  await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
  await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1000 });
  await emitAck(c2, 'room:join', { roomId: 'room_1' });
  const started = once(c1, 'game:start');
  await emitAck(c1, 'room:ready', true);
  await emitAck(c2, 'room:ready', true);
  await started;
  return { c1, c2 };
}

test('staked 1v1: stakes escrowed at start; winner paid pot − rake; ledger reconciles', async () => {
  const h = await staked1v1(1); // a single won game ends the match
  const { c1, c2 } = await startStakedMatch(h);
  try {
    assert.equal(await h.wallet.getBalance(h.u1), 0); // escrowed
    assert.equal(await h.wallet.getBalance(h.u2), 0);

    const end = once(c1, 'match:end');
    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] }); // seat 0 wins
    const result = await end;

    assert.equal(result.payoutCents, 1800);
    assert.equal(await h.wallet.getBalance(h.u1), 1800);
    assert.equal(await h.wallet.getBalance(h.u2), 0);
    assert.equal((await h.wallet.reconcile()).ok, true);
  } finally {
    c1.close(); c2.close(); await h.close();
  }
});

test('leaving mid-match forfeits the pot to the opponent — escrow is never leaked', async () => {
  const h = await staked1v1(100); // match would otherwise continue
  const { c1, c2 } = await startStakedMatch(h);
  try {
    assert.equal(await h.wallet.getBalance(h.u1), 0);
    assert.equal(await h.wallet.getBalance(h.u2), 0);

    const end = once(c1, 'match:end');
    await emitAck(c2, 'room:leave'); // seat 1 walks away mid-match
    const result = await end;

    assert.deepEqual(result.winnerSeats, [0]);   // opponent takes it
    assert.equal(result.payoutCents, 1800);
    assert.equal(await h.wallet.getBalance(h.u1), 1800); // paid, not stuck escrowed
    assert.equal(await h.wallet.getBalance(h.u2), 0);
    assert.equal((await h.wallet.reconcile()).ok, true);
  } finally {
    c1.close(); c2.close(); await h.close();
  }
});

test('disconnect mid-match: after the abandon grace expires, the pot forfeits to the opponent', async () => {
  // Short grace so the timer fires fast; the assertion AWAITS the match:end event
  // (not a fixed sleep), so it is deterministic, not flaky.
  const h = await staked1v1(100, { abandonMs: 40 });
  const { c1, c2 } = await startStakedMatch(h);
  try {
    assert.equal(await h.wallet.getBalance(h.u1), 0);
    assert.equal(await h.wallet.getBalance(h.u2), 0);

    const end = once(c1, 'match:end'); // c1 stays connected and should win
    c2.close(); // seat 1 DROPS (not an explicit leave) → server starts the abandon grace
    const result = await end;

    assert.deepEqual(result.winnerSeats, [0]); // grace expired → forfeit to the present player
    assert.equal(result.payoutCents, 1800);
    assert.equal(await h.wallet.getBalance(h.u1), 1800);
    assert.equal(await h.wallet.getBalance(h.u2), 0);
    assert.equal((await h.wallet.reconcile()).ok, true);
  } finally {
    c1.close(); await h.close();
  }
});

// ---- match continuation when a player abandons (1v1v1 / 2v2) ----------------

/** A staked N-player server (1v1v1 = 3, 2v2 = 4), each player funded exactly the
 *  stake so post-escrow balances are 0 and payouts read directly. Seat 0 holds 3♠. */
async function stakedRoom(
  type: '1v1v1' | '2v2',
  startTarget: number,
  gatewayOpts: { abandonMs?: number } = {},
): Promise<{ port: number; wallet: WalletService; type: typeof type; n: number; users: Array<{ id: string; token: string }>; close: () => Promise<void> }> {
  const n = type === '1v1v1' ? 3 : 4;
  const handsByType: Record<string, Card[][]> = {
    '1v1v1': [[c('3', 'S'), c('6', 'S')], [c('4', 'S'), c('7', 'S')], [c('5', 'S'), c('8', 'S')]],
    '2v2': [[c('3', 'S'), c('7', 'S')], [c('4', 'S'), c('8', 'S')], [c('5', 'S'), c('9', 'S')], [c('6', 'S'), c('10', 'S')]],
  };
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const money = new MoneyService(wallet, new InMemoryMatchesRepository());
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget,
    dealerFactory: () => () => handsByType[type]!.map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let k = 0; return () => `room_${(k += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, money, rakeBps: 1_000, abandonMs: 60_000, provablyFair: false, ...gatewayOpts });
  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const users: Array<{ id: string; token: string }> = [];
  for (let i = 0; i < n; i++) {
    const u = await auth.register({ username: `plyr${i}`, email: `plyr${i}@a.com`, password: `password${i}` });
    await wallet.credit(u.user.id, 1000, { type: 'deposit' });
    users.push({ id: u.user.id, token: u.tokens.accessToken });
  }
  return { port, wallet, type, n, users, close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }) };
}

async function startMatchN(h: { port: number; type: string; n: number; users: Array<{ token: string }> }): Promise<any[]> {
  const clients = h.users.map((u) => ioClient(`http://localhost:${h.port}`, { auth: { token: u.token }, transports: ['websocket'], forceNew: true }));
  await Promise.all(clients.map((cl) => once(cl, 'connect')));
  await emitAck(clients[0], 'room:create', { type: h.type, stakeCents: 1000 });
  for (let i = 1; i < h.n; i++) await emitAck(clients[i], 'room:join', { roomId: 'room_1' });
  const started = once(clients[0], 'game:start');
  for (let i = 0; i < h.n; i++) await emitAck(clients[i], 'room:ready', true);
  await started;
  return clients;
}

test('staked 1v1v1: one leaving CONTINUES the match; a second quit pays the lone survivor (quitters lose)', async () => {
  const h = await stakedRoom('1v1v1', 100); // high target → won't end on points
  const clients = await startMatchN(h);
  try {
    for (const u of h.users) assert.equal(await h.wallet.getBalance(u.id), 0); // all escrowed

    // Seat 1 leaves → the match CONTINUES (match:playerLeft, NOT match:end). No payout yet.
    const left = once(clients[0], 'match:playerLeft');
    await emitAck(clients[1], 'room:leave');
    assert.equal((await left).seat, 1);
    for (const u of h.users) assert.equal(await h.wallet.getBalance(u.id), 0); // still escrowed

    // Seat 2 leaves too → only seat 0 remains → match ends, seat 0 takes the 3-stake pot − 10%.
    const end = once(clients[0], 'match:end');
    await emitAck(clients[2], 'room:leave');
    const result = await end;
    assert.deepEqual(result.winnerSeats, [0]);
    assert.equal(result.payoutCents, 2700); // 3000 pot − 300 rake
    assert.equal(await h.wallet.getBalance(h.users[0]!.id), 2700);
    assert.equal(await h.wallet.getBalance(h.users[1]!.id), 0); // quitter loses
    assert.equal(await h.wallet.getBalance(h.users[2]!.id), 0); // quitter loses
    assert.equal((await h.wallet.reconcile()).ok, true);
  } finally {
    for (const cl of clients) cl.close();
    await h.close();
  }
});

test('staked 2v2: play continues when one leaves; a whole team leaving makes the other team split the pot', async () => {
  const h = await stakedRoom('2v2', 100);
  const clients = await startMatchN(h); // seats: 0&2 = team0, 1&3 = team1
  try {
    for (const u of h.users) assert.equal(await h.wallet.getBalance(u.id), 0);

    // Seat 1 (team1) leaves → continue (team1 still has seat 3).
    const left = once(clients[0], 'match:playerLeft');
    await emitAck(clients[1], 'room:leave');
    assert.equal((await left).seat, 1);
    assert.equal(await h.wallet.getBalance(h.users[0]!.id), 0); // still escrowed

    // Seat 3 (team1) leaves → team1 fully gone → team0 wins; seats 0 & 2 split pot − rake.
    const end = once(clients[0], 'match:end');
    await emitAck(clients[3], 'room:leave');
    const result = await end;
    assert.deepEqual([...result.winnerSeats].sort((a: number, b: number) => a - b), [0, 2]);
    // pot = 4 × 1000 = 4000; − 10% rake = 3600; split two ways = 1800 each.
    assert.equal(await h.wallet.getBalance(h.users[0]!.id), 1800);
    assert.equal(await h.wallet.getBalance(h.users[2]!.id), 1800);
    assert.equal(await h.wallet.getBalance(h.users[1]!.id), 0); // quitter loses
    assert.equal(await h.wallet.getBalance(h.users[3]!.id), 0); // quitter loses
    assert.equal((await h.wallet.reconcile()).ok, true);
  } finally {
    for (const cl of clients) cl.close();
    await h.close();
  }
});

test('rate limiter: once a user’s bucket is empty, further intents are rejected with rate_limited', async () => {
  // capacity 1, refill 0/s → exactly one intent allowed, the next is rejected
  // deterministically (no time-based refill to race).
  const h = await staked1v1(1, { rateLimiter: new RateLimiter(1, 0) });
  const c1: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.t1 }, transports: ['websocket'], forceNew: true });
  try {
    await once(c1, 'connect');
    const first = await emitAck<any>(c1, 'room:create', { type: '1v1', stakeCents: 0 });
    assert.ok(first.ok); // first intent consumes the only token
    const second = await emitAck<any>(c1, 'room:create', { type: '1v1', stakeCents: 0 });
    assert.equal(second.ok, false);
    assert.equal(second.error?.code, 'rate_limited'); // bucket empty → gated before the handler runs
  } finally {
    c1.close(); await h.close();
  }
});
