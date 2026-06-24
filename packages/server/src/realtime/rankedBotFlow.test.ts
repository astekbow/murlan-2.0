// ============================================================================
// MURLAN — Ranked solo-queue → vs-BOT fallback integration.
// Proves: a lone player who queues ranked with NO human opponent is, after the
// (injected, tiny) bot timer, seated into a RATED (non-practice) ranked room filled
// with bots; on match end the human's MMR is updated (delta non-zero) and NO season
// write is ever attempted for a bot userid (the #1 FK risk). A practice match in the
// same setup still rates nothing.
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
import { InMemorySeasonRepository, type UserSeason } from '../ranked/seasonRepository.ts';
import { RankedService } from '../ranked/rankedService.ts';
import { MatchmakingService } from './matchmaking.ts';
import { BOT_PREFIX } from './gatewayHelpers.ts';

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

/** Season repo that records every userId an upsert touched — to prove no bot is written. */
class SpySeasonRepo extends InMemorySeasonRepository {
  public readonly upsertedUserIds: string[] = [];
  override async upsertUserSeason(row: UserSeason): Promise<void> {
    this.upsertedUserIds.push(row.userId);
    return super.upsertUserSeason(row);
  }
}

async function harness(withSeason: boolean) {
  const httpServer: HttpServer = createServer();
  const io = new Server(httpServer);
  const repo = new InMemoryUserRepository();
  const seasons = new SpySeasonRepo();
  const ranked = new RankedService(seasons, repo);
  const matchmaking = new MatchmakingService();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const rooms = new RoomManager({
    startTarget: 1, // a single won game ends the match
    // Seat 0 (human) holds 3♠ → leads + plays its only card → goes out → wins.
    dealerFactory: () => () => [[c('3', 'S')], [c('4', 'S')]].map((h) => h.map((x) => ({ ...x }))),
    idFactory: (() => { let n = 0; return () => `room_${(n += 1)}`; })(),
  });
  // Inject a tiny rankedBotMs (30ms) so the no-opponent fallback fires deterministically;
  // bots act near-instantly. provablyFair off to script the deal.
  new GameGateway(io, rooms, auth, {
    countdownMs: 20, turnMs: 5_000, ranked, matchmaking, provablyFair: false, botDelayMs: 1, rankedBotMs: 30,
  });
  if (withSeason) await ranked.createSeason('Sezoni Test');

  await new Promise<void>((res) => httpServer.listen(0, res));
  const port = (httpServer.address() as AddressInfo).port;
  const u = await auth.register({ username: 'solo', email: 's@s.com', password: 'password1' });
  return {
    ranked, seasons, rooms, port, userId: u.user.id, token: u.tokens.accessToken,
    close: () => new Promise<void>((res) => { io.close(); httpServer.close(() => res()); }),
  };
}

test('ranked vs-bot fallback: a lone queuer is seated vs bots, gets RATED, and no bot userid is ever written', async () => {
  const h = await harness(true);
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');

    // Arm the deal listener BEFORE queueing — the bot fallback will start the match ~30ms later.
    const started = once(cli, 'game:start');
    const q = await emitAck<any>(cli, 'ranked:queue:join', { matchType: '1v1' });
    assert.equal(q.ok, true);

    const gs = await started; // the fallback fired: seated vs a bot + dealt in
    assert.equal(gs.hand.length, 1, 'scripted 1v1 deal');

    // The room must be RANKED (not practice) and zero-stake, with the human + one bot seated.
    const lobby = await emitAck<any>(cli, 'lobby:list');
    assert.equal(lobby.rooms.length, 0, 'ranked rooms are hidden from the public lobby');
    const room = h.rooms.getRoom('room_1');
    assert.ok(room, 'room exists');
    assert.equal(room!.ranked, true, 'room is ranked');
    assert.equal(room!.practice, false, 'room is NOT practice (so it rates + awards the human)');
    assert.equal(room!.stakeCents, 0, 'ranked rooms are zero-stake');
    const botSeats = room!.seats.filter((s) => s.userId && s.userId.startsWith(BOT_PREFIX));
    assert.equal(botSeats.length, 1, 'the empty seat was filled with a bot');

    // Human plays its only card (3♠) → goes out → wins → the match ends.
    const end = once(cli, 'match:end');
    await emitAck(cli, 'game:play', { cards: [c('3', 'S')] });
    await end;

    // MMR is isolated/fire-and-forget — poll for the human's rating to move off the default.
    let me = await h.ranked.getUserRanked(h.userId);
    for (let i = 0; i < 30 && me.games === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      me = await h.ranked.getUserRanked(h.userId);
    }
    assert.equal(me.games, 1, 'the human was rated (one game recorded)');
    assert.equal(me.wins, 1, 'the win was recorded');
    // Even-rated synthetic bot opponent ⇒ expected 0.5 ⇒ +K/2 = +16 from the default 1000.
    assert.equal(me.rating, 1016, 'a vs-bot win moves MMR by the full K/2 swing');
    assert.notEqual(me.rating, 1000, 'MMR delta is non-zero');

    // CRITICAL: not a single season write may target a bot userid (would FK-violate on Postgres).
    const botWrites = h.seasons.upsertedUserIds.filter((id) => id.startsWith(BOT_PREFIX));
    assert.deepEqual(botWrites, [], 'no season write was attempted for a bot userid');
    assert.ok(h.seasons.upsertedUserIds.includes(h.userId), 'the human WAS written');
  } finally {
    cli.close();
    await h.close();
  }
});

test('ranked vs-bot fallback: with NO active season it is a clean no-op (no MMR write at all)', async () => {
  const h = await harness(false);
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const started = once(cli, 'game:start');
    await emitAck(cli, 'ranked:queue:join', { matchType: '1v1' });
    await started;
    const end = once(cli, 'match:end');
    await emitAck(cli, 'game:play', { cards: [c('3', 'S')] });
    await end;
    await new Promise((r) => setTimeout(r, 150)); // give any stray hook time to (not) fire
    const me = await h.ranked.getUserRanked(h.userId);
    assert.equal(me.season, null);
    assert.equal(me.rating, 1000);
    assert.equal(me.games, 0);
    assert.deepEqual(h.seasons.upsertedUserIds, [], 'no season write at all when ranked is off');
  } finally {
    cli.close();
    await h.close();
  }
});

test('practice in the same setup still rates NOTHING (no season write, human or bot)', async () => {
  const h = await harness(true); // active season present
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    const started = once(cli, 'game:start');
    const res = await emitAck<any>(cli, 'practice:start', { type: '1v1', tier: 'medium' });
    assert.equal(res.ok, true);
    await started;
    const room = h.rooms.getRoom('room_1');
    assert.equal(room!.practice, true, 'practice room is flagged practice');

    const end = once(cli, 'match:end');
    await emitAck(cli, 'game:play', { cards: [c('3', 'S')] });
    await end;
    await new Promise((r) => setTimeout(r, 150));

    const me = await h.ranked.getUserRanked(h.userId);
    assert.equal(me.games, 0, 'practice is never rated');
    assert.equal(me.rating, 1000);
    assert.deepEqual(h.seasons.upsertedUserIds, [], 'practice writes no season row (human or bot)');
  } finally {
    cli.close();
    await h.close();
  }
});

test('ranked vs-bot timer is cancelled when the player leaves the queue (no fallback room is created)', async () => {
  const h = await harness(true);
  const cli: any = ioClient(`http://localhost:${h.port}`, { auth: { token: h.token }, transports: ['websocket'], forceNew: true });
  try {
    await once(cli, 'connect');
    await emitAck(cli, 'ranked:queue:join', { matchType: '1v1' });
    // Before the 30ms bot timer fires, leaving the queue must cancel the fallback.
    await emitAck(cli, 'ranked:queue:leave');
    await new Promise((r) => setTimeout(r, 100)); // well past rankedBotMs (30ms)
    assert.equal(h.rooms.getRoom('room_1'), undefined, 'leaving the queue cancels the vs-bot fallback');
    const me = await h.ranked.getUserRanked(h.userId);
    assert.equal(me.games, 0, 'no match was played');
    assert.deepEqual(h.seasons.upsertedUserIds, [], 'no rating write occurred');
  } finally {
    cli.close();
    await h.close();
  }
});
