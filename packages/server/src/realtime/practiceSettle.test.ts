// ============================================================================
// MURLAN — practice match:end with MONEY wired (production config).
// Regression for the audit finding (2026-07-03): in production `money` is always
// wired, but practice rooms are never escrowed (no `matches` row), so calling
// money.settle for a finished practice match returned null and the gateway BAILED
// without emitting match:end — every completed practice match froze on the final
// board with no results screen. practiceFlow.test.ts missed it by building the
// gateway with NO money. This builds it WITH money (like prod) and asserts
// match:end still fires for a practice match, with payoutCents null.
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
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryMatchesRepository } from '../money/matchesRepository.ts';
import { MoneyService } from '../money/moneyService.ts';
import { GameGateway } from './gateway.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });
const once = <T = any>(socket: any, ev: string, ms = 4000): Promise<T> =>
  new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`timeout ${ev}`)), ms); socket.once(ev, (d: T) => { clearTimeout(t); resolve(d); }); });
const emitAck = <T = any>(socket: any, ev: string, ...a: any[]): Promise<T> =>
  new Promise((res) => socket.emit(ev, ...a, (r: T) => res(r)));

test('practice match still emits match:end when money is wired (prod config), payoutCents null', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const wallet = new WalletService(repo, new InMemoryLedger());
  const money = new MoneyService(wallet, new InMemoryMatchesRepository()); // <-- prod wires this; practice must survive it
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1, // one won game ends the match
    dealerFactory: () => () => [[c('3', 'S'), c('6', 'S')], [c('4', 'S'), c('5', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  new GameGateway(io, rooms, auth, { countdownMs: 20, turnMs: 5_000, provablyFair: false, botDelayMs: 1, money, rakeBps: 1_000 });
  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u = await auth.register({ username: 'human', email: 'h@h.com', password: 'password1' });

  const cli: any = ioClient(`http://localhost:${port}`, { auth: { token: u.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const started = once(cli, 'game:start');
    const res = await emitAck(cli, 'practice:start', { type: '1v1', tier: 'medium' });
    assert.equal(res.ok, true);
    await started;

    // Human opens 3♠ → bot responds → human plays 6♠, goes out, wins → match must END.
    const end = once<any>(cli, 'match:end', 6000); // WITHOUT the fix this NEVER arrives (settle→null→bail)
    await emitAck(cli, 'game:play', { cards: [c('3', 'S')] });
    // Give the bot its move, then finish.
    await new Promise((r) => setTimeout(r, 60));
    await emitAck(cli, 'game:play', { cards: [c('6', 'S')] });
    const result = await end;
    assert.ok(result.winnerSeats.includes(0), 'the human (seat 0) won the practice match');
    assert.equal(result.payoutCents, null, 'practice pays nothing → payoutCents is null');
    // The human never lost money to a phantom escrow.
    assert.equal(await wallet.getBalance(u.user.id), 0);
  } finally {
    cli.close();
    await new Promise<void>((res) => { io.close(); httpServer.close(() => res()); });
  }
});
