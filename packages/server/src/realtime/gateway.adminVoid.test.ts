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
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryMatchesRepository } from '../money/matchesRepository.ts';
import { MoneyService } from '../money/moneyService.ts';
import { GameGateway } from './gateway.ts';

// A money-wired gateway harness (the base gateway.test.ts runs without money).
// Used to exercise the admin match-void end-to-end: a real staked match is
// escrowed via the socket flow, then voided directly via the gateway method.

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

function connect(port: number, token: string): any {
  return ioClient(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], forceNew: true });
}

function once<T = any>(socket: any, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

function emitAck<T = any>(socket: any, event: string, ...args: any[]): Promise<T> {
  return new Promise((resolve) => socket.emit(event, ...args, (res: T) => resolve(res)));
}

async function moneyHarness() {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const users = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger);
  const matches = new InMemoryMatchesRepository();
  const money = new MoneyService(wallet, matches);
  const tokenSvc = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(users, tokenSvc);
  const rooms = new RoomManager({
    startTarget: 1,
    dealerFactory: scripted([[[c('3', 'S')], [c('4', 'S')]]]),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  const gateway = new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, provablyFair: false, money, rakeBps: 1_000 });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;

  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });
  await wallet.adminAdjust(u1.user.id, 100_000, 'seed');
  await wallet.adminAdjust(u2.user.id, 100_000, 'seed');

  return {
    port, rooms, gateway, wallet, matches,
    ids: { u1: u1.user.id, u2: u2.user.id },
    tokens: { t1: u1.tokens.accessToken, t2: u2.tokens.accessToken },
    close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }),
  };
}

test('admin void refunds every stake, cancels the match, reconciles, and is idempotent', async () => {
  const h = await moneyHarness();
  const c1 = connect(h.port, h.tokens.t1);
  const c2 = connect(h.port, h.tokens.t2);
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    const created = await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1_000 });
    assert.ok(created.ok);
    await emitAck(c2, 'room:join', { roomId: created.roomId });

    const start1 = once(c1, 'game:start');
    await emitAck(c1, 'room:ready', true);
    await emitAck(c2, 'room:ready', true);
    await start1; // match started ⇒ stakes were escrowed

    assert.equal(await h.wallet.getBalance(h.ids.u1), 99_000);
    assert.equal(await h.wallet.getBalance(h.ids.u2), 99_000);
    const matchId = h.rooms.matchIdOf(created.roomId)!;
    assert.ok(matchId);

    const res = await h.gateway.adminVoidMatch(created.roomId, { adminId: 'admin', reason: 'collusion' });
    assert.deepEqual(res, { ok: true, matchId, refunded: true });

    // Every stake returned in full (no rake); the match record is cancelled.
    assert.equal(await h.wallet.getBalance(h.ids.u1), 100_000);
    assert.equal(await h.wallet.getBalance(h.ids.u2), 100_000);
    assert.equal((await h.matches.find(matchId))!.status, 'cancelled');
    // Money invariants hold: balances reconcile + the match's ledger sums to 0.
    assert.equal((await h.wallet.reconcile()).ok, true);
    assert.equal((await h.wallet.matchLedgerSums()).get(matchId), 0);
    // The room is no longer an in-progress match.
    assert.equal(h.rooms.listActiveMatches().length, 0);

    // Idempotent: a second void can't re-refund (already finalized).
    const again = await h.gateway.adminVoidMatch(created.roomId, { adminId: 'admin', reason: 'x' });
    assert.equal(again.ok, false);
    assert.equal(await h.wallet.getBalance(h.ids.u1), 100_000); // unchanged
  } finally {
    c1.close(); c2.close(); await h.close();
  }
});

test('admin void rejects an unknown room and a room not in a match', async () => {
  const h = await moneyHarness();
  const c1 = connect(h.port, h.tokens.t1);
  try {
    await once(c1, 'connect');
    assert.deepEqual(await h.gateway.adminVoidMatch('nope', { adminId: 'a', reason: 'x' }), { ok: false, reason: 'not_found' });

    const created = await emitAck(c1, 'room:create', { type: '1v1', stakeCents: 1_000 });
    // Created but never started → still 'waiting', not 'inMatch'.
    assert.deepEqual(await h.gateway.adminVoidMatch(created.roomId, { adminId: 'a', reason: 'x' }), { ok: false, reason: 'not_in_match' });
  } finally {
    c1.close(); await h.close();
  }
});
