// ============================================================================
// MURLAN — Self-running tournament integration: a filled bracket plays itself in
// the live gateway (no admin reporting) and pays the champion pool − rake.
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
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryMatchesRepository } from '../money/matchesRepository.ts';
import { MoneyService } from '../money/moneyService.ts';
import { TournamentService, InMemoryTournamentRepository, type TournamentWallet } from '../tournament/tournamentService.ts';

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

test('staked 2-player tournament: fills → plays itself → champion paid pool − rake', async () => {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const money = new MoneyService(wallet, new InMemoryMatchesRepository());
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));

  // Tournament wallet adapter (mirrors app.ts): escrow buy-ins, pay champion + rake.
  const tWallet: TournamentWallet = {
    async debit(userId, cents, reason) { await wallet.debit(userId, cents, { type: 'bet', reason }); },
    async credit(userId, cents, reason) { await wallet.credit(userId, cents, { type: 'payout', reason, providerRef: reason }); },
    async recordRake(cents, ref) { await wallet.recordRake(cents, { providerRef: ref }); },
    async payoutChampion(winnerId, prizeCents, rakeCents, ref) {
      if (prizeCents > 0) await wallet.credit(winnerId, prizeCents, { type: 'payout', reason: `tournament prize:${ref}`, providerRef: `tournament prize:${ref}` });
      if (rakeCents > 0) await wallet.recordRake(rakeCents, { providerRef: `tournament-rake:${ref}` });
    },
  };
  const tournaments = new TournamentService(new InMemoryTournamentRepository(), tWallet, 1_000); // 10% rake

  const rooms = new RoomManager({
    startTarget: 1, // a single won game decides the pairing
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  const gateway = new GameGateway(io, rooms, auth, { countdownMs: 25, turnMs: 5_000, money, rakeBps: 1_000, tournaments, abandonMs: 60_000, provablyFair: false });

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u1 = await auth.register({ username: 'alpha', email: 'a@a.com', password: 'password1' });
  const u2 = await auth.register({ username: 'beta', email: 'b@b.com', password: 'password2' });
  await wallet.credit(u1.user.id, 1000, { type: 'deposit' });
  await wallet.credit(u2.user.id, 1000, { type: 'deposit' });

  // Open + fill a 2-player, $10 buy-in tournament (escrows both buy-ins → pool 2000).
  const t = await tournaments.create('Test Cup', 1000, 2);
  await tournaments.register(t.id, u1.user.id);
  const filled = await tournaments.register(t.id, u2.user.id);
  assert.equal(filled.status, 'running'); // seeded
  assert.equal(await wallet.getBalance(u1.user.id), 0); // both buy-ins escrowed
  assert.equal(await wallet.getBalance(u2.user.id), 0);

  const c1: any = ioClient(`http://localhost:${port}`, { auth: { token: u1.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  const c2: any = ioClient(`http://localhost:${port}`, { auth: { token: u2.tokens.accessToken }, transports: ['websocket'], forceNew: true });
  try {
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    // The clients auto-join their tournament match when paired (mirrors the gameStore handler).
    c1.on('tournament:matchReady', (d: any) => c1.emit('room:join', { roomId: d.roomId }, () => {}));
    c2.on('tournament:matchReady', (d: any) => c2.emit('room:join', { roomId: d.roomId }, () => {}));

    const start1 = once(c1, 'game:start');
    // Kick off the bracket (in prod the register route does this via onTournamentRunning).
    await gateway.runTournamentMatches(t.id);
    await start1; // seat 0 was dealt its hand → the match is live

    const end = once(c1, 'match:end');
    await emitAck(c1, 'game:play', { cards: [c('3', 'S')] }); // seat 0 wins the pairing (= the final)
    await end;

    // The bracket finished automatically: champion = u1 paid pool(2000) − 10% rake = 1800.
    // Poll briefly (reportResult/finish run off the match:end path).
    let bal1 = 0;
    for (let i = 0; i < 30 && bal1 === 0; i += 1) { await new Promise((r) => setTimeout(r, 20)); bal1 = await wallet.getBalance(u1.user.id); }
    assert.equal(bal1, 1800);
    assert.equal(await wallet.getBalance(u2.user.id), 0); // runner-up gets nothing
    const fin = await tournaments.get(t.id);
    assert.equal(fin?.status, 'finished');
    assert.equal(fin?.winnerId, u1.user.id);
    assert.equal((await wallet.reconcile()).ok, true);
  } finally {
    c1.close(); c2.close();
    io.close();
    await new Promise<void>((res) => httpServer.close(() => res()));
  }
});
