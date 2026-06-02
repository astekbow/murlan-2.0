// ============================================================================
// MURLAN — Socket.IO gateway (Phase 4d)
// ----------------------------------------------------------------------------
// Bridges sockets to the authoritative RoomManager/Match. Responsibilities:
//   • Authenticate every connection from its JWT (handshake or `auth` event).
//   • Translate client intents (create/join/ready/play/pass/switchGive) into
//     RoomManager calls — the SERVER decides everything; the client is untrusted.
//   • Broadcast public state to the room and each player's PRIVATE hand only to
//     that player's own socket(s). Opponents are ever only counts.
//   • Run the ready-check countdown and per-turn timers (auto-pass / forced lead
//     on timeout).
//   • Support reconnection: on (re)connect, push a fresh full state to that one
//     socket — never a broadcast of hidden cards.
// ============================================================================

import type { Server, Socket } from 'socket.io';
import { singlePower, type Card } from '@murlan/engine';
import type {
  ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData,
  Ack, RoomCreatePayload, RoomJoinPayload, GamePlayPayload, SwitchGivePayload,
  CardSwitchDTO,
} from '@murlan/shared';
import type { RoomManager } from '../room/roomManager.ts';
import type { MatchActionResult } from '../match/match.ts';
import { DEFAULT_TEAMS } from '../match/scoring.ts';
import type { AuthService } from '../auth/authService.ts';
import type { MoneyService } from '../money/moneyService.ts';
import { forfeitWinners } from '../money/moneyService.ts';
import { createFairShuffle, combineClientSeeds, generateServerSeed, sha256Hex, type FairShuffle } from '../fair/provablyFair.ts';
import type { GamesRepository } from '../fair/gamesRepository.ts';
import { RateLimiter } from '../util/rateLimiter.ts';
import { isCardArray, isValidCard, isMatchType, isTeam, isValidStake, isNonEmptyString } from './validation.ts';
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ProfileService } from '../profile/profileService.ts';
import type { FriendsService } from '../social/friendsService.ts';
import type { Presence } from './presence.ts';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface GatewayOptions {
  turnMs?: number;       // per-turn timer; default 30s
  countdownMs?: number;  // ready-check countdown before a match starts; default 3s
  money?: MoneyService;  // when present, stakes are escrowed/settled (Phase 6)
  rakeBps?: number;      // house rake in basis points; default 1000 (10%)
  abandonMs?: number;    // reconnection grace before a disconnect forfeits; default 30s
  provablyFair?: boolean; // use the commit-reveal shuffle (default true); tests disable to script deals
  compliance?: ComplianceService; // gates staked play (KYC/age/geo/self-exclusion) when enabled
  profiles?: ProfileService; // awards cosmetic XP/stats at match end (isolated; never affects money)
  friends?: FriendsService;  // gates/handles friend room invites
  presence?: Presence;       // tracks who is online (shared with the friends routes)
  games?: GamesRepository;   // persists provably-fair seeds per game (durable audit)
}

const ackError = (code: string, message: string): Ack => ({ ok: false, error: { code, message } });

// A hostile/buggy client may emit an intent with no ack callback. Calling a
// missing ack throws (and would leave the handler half-run); wrap it so a reply
// is always safe to call and never throws.
function safeAck(ack: unknown): (res: Ack) => void {
  return typeof ack === 'function' ? (ack as (res: Ack) => void) : () => {};
}

// A player who lets this many of their OWN turns time out in a row (never acts)
// is treated as abandoning: the match ends and the still-active side wins the pot.
const IDLE_FORFEIT_STRIKES = 5;

export class GameGateway {
  private readonly turnMs: number;
  private readonly countdownMs: number;
  private readonly money: MoneyService | null;
  private readonly rakeBps: number;
  private readonly abandonMs: number;
  private readonly provablyFair: boolean;
  private readonly compliance: ComplianceService | null;
  private readonly profiles: ProfileService | null;
  private readonly friends: FriendsService | null;
  private readonly presence: Presence | null;
  private readonly games: GamesRepository | null;
  private countdowns = new Map<string, ReturnType<typeof setTimeout>>();
  private countdownDeadlines = new Map<string, number>();
  private turnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private turnDeadlines = new Map<string, number>();
  private abandonTimers = new Map<string, ReturnType<typeof setTimeout>>(); // userId -> timer
  private idleStrikes = new Map<string, number>(); // userId -> consecutive turn timeouts (reset on any real move)
  private finalizedMatches = new Set<string>(); // matchIds whose match:end has been emitted (exactly-once finalize)
  private fairByRoom = new Map<string, FairShuffle>(); // provably-fair shuffle per active match
  private pendingServerSeeds = new Map<string, string>(); // roomId -> serverSeed committed at countdown start
  private clientSeeds = new Map<string, string>(); // userId -> clientSeed (submitted AFTER the commit)
  // Per-user token bucket: 40 burst, 20/s sustained — ample for real play, caps abuse.
  private limiter = new RateLimiter(40, 20);

  constructor(
    private readonly io: IO,
    private readonly rooms: RoomManager,
    private readonly auth: AuthService,
    opts: GatewayOptions = {},
  ) {
    this.turnMs = opts.turnMs ?? 30_000;
    this.countdownMs = opts.countdownMs ?? 3_000;
    this.money = opts.money ?? null;
    this.rakeBps = opts.rakeBps ?? 1_000;
    this.abandonMs = opts.abandonMs ?? 30_000;
    this.provablyFair = opts.provablyFair ?? true;
    this.compliance = opts.compliance ?? null;
    this.profiles = opts.profiles ?? null;
    this.friends = opts.friends ?? null;
    this.presence = opts.presence ?? null;
    this.games = opts.games ?? null;
    this.registerAuth();
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  // ---------- Auth handshake --------------------------------------------------

  private registerAuth(): void {
    this.io.use((socket, next) => {
      const token = (socket.handshake.auth?.token ?? socket.handshake.headers?.authorization?.replace(/^Bearer /, '')) as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      try {
        const { userId, username } = this.auth.verifyAccess(token);
        socket.data.userId = userId;
        socket.data.username = username;
        socket.data.roomId = null;
        socket.data.seat = null;
        socket.data.clientSeed = null;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }

  // ---------- Connection lifecycle -------------------------------------------

  private onConnection(socket: IOSocket): void {
    const { userId } = socket.data;
    void socket.join(personalRoom(userId));
    this.presence?.add(userId);

    // Reconnection: if this user is already seated in a room, re-attach and push
    // a fresh full state to THIS socket only.
    const existing = this.rooms.roomOf(userId);
    if (existing) {
      this.clearAbandonTimer(userId); // they came back before the grace expired
      socket.data.roomId = existing.id;
      socket.data.seat = this.rooms.seatOf(existing.id, userId);
      void socket.join(existing.id);
      this.rooms.setConnected(userId, true);
      this.pushFullStateTo(socket);
      this.broadcastRoomState(existing.id);
    }

    socket.on('lobby:list', (ack) => ack(this.rooms.listLobby()));
    socket.on('room:create', (payload, ack) => this.onCreate(socket, payload, ack));
    socket.on('room:join', (payload, ack) => this.onJoin(socket, payload, ack));
    socket.on('room:leave', (ack) => void this.onLeave(socket, ack));
    socket.on('room:ready', (ready, ack) => this.onReady(socket, ready, ack));
    socket.on('game:play', (payload, ack) => this.onPlay(socket, payload, ack));
    socket.on('game:pass', (ack) => this.onPass(socket, ack));
    socket.on('game:switchGive', (payload, ack) => this.onSwitchGive(socket, payload, ack));
    socket.on('fair:clientSeed', (seed) => {
      if (!this.limiter.allow(socket.data.userId)) return;
      if (typeof seed === 'string' && seed.length > 0 && seed.length <= 128) {
        socket.data.clientSeed = seed;
        this.clientSeeds.set(socket.data.userId, seed);
      }
    });
    socket.on('auth', (token, ack) => this.onReAuth(socket, token, ack));

    // ----- Social: in-room emotes / quick-chat + friend room invites ---------
    socket.on('emote', (emote) => {
      const userId = socket.data.userId;
      if (!this.limiter.allow(userId) || typeof emote !== 'string' || !emote) return;
      const room = this.rooms.roomOf(userId);
      if (!room) return;
      const seat = this.rooms.seatOf(room.id, userId);
      if (seat < 0) return;
      this.io.to(room.id).emit('emote', { seat, emote: emote.slice(0, 16) });
    });
    socket.on('chat', (text) => {
      const userId = socket.data.userId;
      if (!this.limiter.allow(userId) || typeof text !== 'string' || !text.trim()) return;
      const room = this.rooms.roomOf(userId);
      if (!room) return;
      const seat = this.rooms.seatOf(room.id, userId);
      if (seat < 0) return;
      this.io.to(room.id).emit('chat', { seat, username: socket.data.username, text: text.slice(0, 80) });
    });
    socket.on('room:invite', (payload, ack) => void this.onInvite(socket, payload, ack));

    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  private onDisconnect(socket: IOSocket): void {
    const { userId } = socket.data;
    // If other sockets for this user remain, keep state untouched.
    if (this.socketCountFor(userId) > 0) return;
    this.limiter.release(userId); // no sockets left — free the rate bucket
    this.clientSeeds.delete(userId); // don't carry a stale seed into a future match
    this.presence?.remove(userId); // last socket gone — mark offline

    const room = this.rooms.roomOf(userId);
    if (!room) return;
    if (room.status === 'inMatch') {
      // Keep the seat for reconnection; mark offline and start the forfeit grace.
      this.rooms.setConnected(userId, false);
      this.broadcastRoomState(room.id);
      this.startAbandonTimer(room.id, userId);
    } else {
      // Not started yet — free the seat so the lobby stays clean.
      this.leaveAndNotify(userId, room.id);
    }
  }

  private onReAuth(socket: IOSocket, token: string, ack: (res: Ack) => void): void {
    if (!this.rateOk(socket, ack)) return;
    try {
      const { userId, username } = this.auth.verifyAccess(token);
      // A connection may only REFRESH its own session, never rebind to a
      // different user (that would desync rooms/seats and could leak hands).
      if (userId !== socket.data.userId) {
        return ack(ackError('identity_mismatch', 'Nuk mund të ndryshosh identitetin e lidhjes.'));
      }
      socket.data.username = username;
      ack({ ok: true });
    } catch {
      ack(ackError('unauthorized', 'Token i pavlefshëm.'));
    }
  }

  // ---------- Intent handlers -------------------------------------------------

  /** Per-user rate gate for ack-based intents. Returns true if the call should proceed. */
  private rateOk(socket: IOSocket, ack: (res: Ack) => void): boolean {
    if (this.limiter.allow(socket.data.userId)) return true;
    ack(ackError('rate_limited', 'Shumë veprime — ngadalëso.'));
    return false;
  }

  private onCreate(socket: IOSocket, payload: RoomCreatePayload, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (!payload || !isMatchType(payload.type) || !isValidStake(payload.stakeCents) || !isTeam(payload.team)) {
      return reply(ackError('bad_request', 'Kërkesë e pavlefshme për krijim dhome.'));
    }
    try {
      const res = this.rooms.createRoom(actor(socket), payload);
      if (!res.ok || !res.roomId) return reply({ ok: false, error: res.error });
      socket.data.roomId = res.roomId;
      socket.data.seat = this.rooms.seatOf(res.roomId, socket.data.userId);
      void socket.join(res.roomId);
      reply({ ok: true, roomId: res.roomId });
      this.broadcastRoomState(res.roomId);
      this.broadcastLobby();
    } catch (e) {
      console.error('[gateway] onCreate failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }

  private onJoin(socket: IOSocket, payload: RoomJoinPayload, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (!payload || !isNonEmptyString(payload.roomId) || !isTeam(payload.team)) {
      return reply(ackError('bad_request', 'Kërkesë e pavlefshme për bashkim.'));
    }
    try {
      const res = this.rooms.joinRoom(actor(socket), payload.roomId, payload.team);
      if (!res.ok) return reply({ ok: false, error: res.error });
      socket.data.roomId = payload.roomId;
      socket.data.seat = this.rooms.seatOf(payload.roomId, socket.data.userId);
      void socket.join(payload.roomId);
      reply({ ok: true, roomId: payload.roomId });
      this.broadcastRoomState(payload.roomId);
      this.broadcastLobby();
      this.maybeStartCountdown(payload.roomId);
    } catch (e) {
      console.error('[gateway] onJoin failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }

  private async onLeave(socket: IOSocket, ack: (res: Ack) => void): Promise<void> {
    const reply = safeAck(ack);
    // Leaving is ALWAYS allowed — never gate it behind the rate limiter (a
    // throttled player must still be able to quit a room/match).
    const roomId = socket.data.roomId;
    if (!roomId) return reply(ackError('no_room', 'Nuk je në një dhomë.'));
    const room = this.rooms.getRoom(roomId);
    const seat = this.rooms.seatOf(roomId, socket.data.userId);
    const userId = socket.data.userId;

    // Detach this socket from the room immediately.
    void socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.seat = null;

    if (room && room.status === 'inMatch' && seat >= 0) {
      // Mid-match leave is a forfeit. AWAIT settlement + free the seat BEFORE
      // acking, so membership (userRoom) is released by the time the client gets
      // ok — otherwise an instant re-create/join would hit 'already_in_room'.
      await this.forfeitMatch(roomId, seat);
      this.rooms.leaveRoom(userId);
      this.broadcastLobby();
    } else {
      this.leaveAndNotify(userId, roomId);
    }
    reply({ ok: true });
  }

  private onReady(socket: IOSocket, ready: boolean, ack: (res: Ack) => void): void {
    if (!this.rateOk(socket, ack)) return;
    const res = this.rooms.setReady(socket.data.userId, ready);
    if (!res.ok) return ack({ ok: false, error: res.error });
    ack({ ok: true });
    const roomId = socket.data.roomId;
    if (roomId) {
      this.broadcastRoomState(roomId);
      this.maybeStartCountdown(roomId);
    }
  }

  private onPlay(socket: IOSocket, payload: GamePlayPayload, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (!payload || !isCardArray(payload.cards)) {
      return reply(ackError('bad_request', 'Letra të pavlefshme.'));
    }
    try {
      const res = this.rooms.play(socket.data.userId, payload.cards);
      this.afterAction(res, reply, socket, 'game:play');
    } catch (e) {
      console.error('[gateway] onPlay failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }
  private onPass(socket: IOSocket, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    try {
      const res = this.rooms.pass(socket.data.userId);
      this.afterAction(res, reply, socket, 'game:pass');
    } catch (e) {
      console.error('[gateway] onPass failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }
  private onSwitchGive(socket: IOSocket, payload: SwitchGivePayload, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (!payload || !isValidCard(payload.card)) {
      return reply(ackError('bad_request', 'Letër e pavlefshme.'));
    }
    try {
      const res = this.rooms.switchGive(socket.data.userId, payload.card);
      this.afterAction(res, reply, socket, 'game:switchGive');
    } catch (e) {
      console.error('[gateway] onSwitchGive failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }

  private afterAction(
    res: MatchActionResult & { roomId?: string },
    ack: (r: Ack) => void,
    socket: IOSocket,
    event: string,
  ): void {
    if (!res.ok) {
      // Server-authoritative rejection: log the illegal/impossible move (spec §9).
      console.warn('[anti-cheat] rejected move', { event, userId: socket.data.userId, roomId: socket.data.roomId, reason: res.reason });
      return ack(ackError('illegal', res.reason ?? 'Lëvizje e palejuar.'));
    }
    ack({ ok: true });
    this.idleStrikes.delete(socket.data.userId); // a real move resets the AFK counter
    if (res.roomId) this.applyResult(res.roomId, res);
  }

  // ---------- Ready-check countdown ------------------------------------------

  private maybeStartCountdown(roomId: string): void {
    if (!this.rooms.allReady(roomId)) {
      this.clearCountdown(roomId);
      return;
    }
    if (this.countdowns.has(roomId)) return; // already counting down

    // Provably-fair COMMIT happens here — BEFORE clientSeeds are collected for
    // this match. We generate+commit the serverSeed, discard any pre-commit
    // clientSeeds, and let clients submit fresh seeds during the countdown. This
    // is what stops the server from grinding the deal (the seed is fixed first).
    if (this.provablyFair) {
      const { serverSeed, serverSeedHash } = generateServerSeed();
      this.pendingServerSeeds.set(roomId, serverSeed);
      const room = this.rooms.getRoom(roomId);
      if (room) for (const s of room.seats) if (s.userId) this.clientSeeds.delete(s.userId);
      this.io.to(roomId).emit('fair:commit', { serverSeedHash });
    }

    this.countdownDeadlines.set(roomId, Date.now() + this.countdownMs);
    const handle = setTimeout(() => {
      this.countdowns.delete(roomId);
      this.countdownDeadlines.delete(roomId);
      void this.beginMatch(roomId);
    }, this.countdownMs);
    this.countdowns.set(roomId, handle);
    this.broadcastRoomState(roomId); // push the countdown to clients immediately
  }

  /** Escrow stakes (if money is enabled), then start the match and deal game 1. */
  private async beginMatch(roomId: string): Promise<void> {
    try {
      await this.tryBeginMatch(roomId);
    } catch (err) {
      // Surface the root cause server-side — a swallowed exception here was the
      // reason a staked match silently failed to start (see start_failed).
      console.error(`[beginMatch] failed to start match in ${roomId}:`, err);
      // Never strand players "ready" or strand an escrowed pot on an unexpected
      // error — refund any escrow, unready players, and report.
      const matchId = this.rooms.matchIdOf(roomId);
      if (this.money && matchId) await this.money.refund(matchId).catch(() => undefined);
      const room = this.rooms.getRoom(roomId);
      if (room && room.status !== 'inMatch') {
        for (const s of room.seats) if (s.userId) this.rooms.setReady(s.userId, false);
        this.broadcastRoomState(roomId);
        this.io.to(roomId).emit('error', { code: 'start_failed', message: 'Ndeshja nuk filloi dot. Provoni sërish.' });
      }
    }
  }

  private async tryBeginMatch(roomId: string): Promise<void> {
    if (!this.rooms.allReady(roomId)) return; // someone unreadied/left during the countdown
    const room = this.rooms.getRoom(roomId);
    if (!room) return;

    // A fresh unique match id per match — never the reusable room id — so a room
    // replayed after a finished match can't collide with the old escrow record.
    const prevMatchId = this.rooms.matchIdOf(roomId);
    if (prevMatchId) this.finalizedMatches.delete(prevMatchId); // bound the finalize set
    const matchId = this.rooms.assignMatchId(roomId);
    if (!matchId) return;

    // Compliance gate (spec §13): for staked matches, every player must clear the
    // enabled KYC/age/geo/self-exclusion checks before any money moves.
    if (room.stakeCents > 0 && this.compliance?.enabled) {
      let blocked = false;
      for (const s of room.seats) {
        if (!s.userId) continue;
        const profile = await this.auth.getComplianceProfile(s.userId);
        const verdict = profile
          ? this.compliance.checkRealMoney(profile)
          : { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
        if (!verdict.allowed) {
          blocked = true;
          this.rooms.setReady(s.userId, false);
          this.io.to(personalRoom(s.userId)).emit('error', { code: verdict.code ?? 'compliance', message: verdict.message ?? 'Bllokuar nga rregullat.' });
        }
      }
      if (blocked) {
        this.broadcastRoomState(roomId);
        return;
      }
    }

    let escrowed = false;
    if (this.money) {
      const players = room.seats
        .map((s, seat) => ({ seat, userId: s.userId }))
        .filter((p): p is { seat: number; userId: string } => p.userId !== null);
      const escrow = await this.money.escrow({
        matchId,
        type: room.type,
        stakeCents: room.stakeCents,
        rakeBps: this.rakeBps,
        players,
      });
      if (!escrow.ok) {
        // Someone can't cover the stake: cancel their ready flag and inform them.
        for (const userId of escrow.insufficientUserIds ?? []) {
          this.rooms.setReady(userId, false);
          this.io.to(personalRoom(userId)).emit('error', { code: 'insufficient_funds', message: 'Bilanc i pamjaftueshëm për bastin.' });
        }
        this.broadcastRoomState(roomId);
        return;
      }
      escrowed = true;
    }

    // Provably-fair DEAL: use the serverSeed committed at countdown start, mixed
    // with the clientSeeds players submitted AFTER the commit. The serverSeed was
    // fixed before these clientSeeds existed, so the deal cannot be ground.
    // (Disabled in tests so deals can be scripted via the RoomManager dealer.)
    let fair: FairShuffle | null = null;
    if (this.provablyFair) {
      const numPlayers = room.seats.length as 2 | 3 | 4;
      let serverSeed = this.pendingServerSeeds.get(roomId);
      if (!serverSeed) {
        // Defensive: no prior commit (shouldn't happen) — commit now.
        const g = generateServerSeed();
        serverSeed = g.serverSeed;
        this.io.to(roomId).emit('fair:commit', { serverSeedHash: g.serverSeedHash });
      }
      const seeds = room.seats.map((s) => (s.userId ? this.clientSeeds.get(s.userId) ?? '' : '')).filter(Boolean);
      if (seeds.length === 0 && room.stakeCents > 0) {
        // No untrusted entropy arrived after the commit — the deal becomes a pure
        // function of the (already-committed, hence reproducible) serverSeed.
        // The official client always contributes; flag this anomaly.
        console.warn('[fair] staked match dealt with no post-commit client entropy', { roomId });
      }
      // Deterministic fallback (derived from the fixed serverSeed) when no client
      // contributed — never a fresh random the server could itself grind.
      const combined = seeds.length > 0 ? combineClientSeeds(seeds) : sha256Hex(`${serverSeed}:auto`);
      fair = createFairShuffle(numPlayers, combined, serverSeed);
    }

    // Wrap deal() to PERSIST each game's seeds the moment it's dealt (revealed=
    // false): the serverSeed is durable from the start, so a crash/disconnect
    // before the post-match reveal never loses the audit trail.
    const matchIdForFair = matchId;
    const dealFn = fair
      ? (): Card[][] => {
          const hands = fair!.deal();
          const index = fair!.games.length - 1; // the game just dealt
          if (this.games) {
            void this.games
              .recordGame({ matchId: matchIdForFair, index, serverSeed: fair!.serverSeed, serverSeedHash: fair!.serverSeedHash, clientSeed: fair!.clientSeed, nonce: index })
              .catch((err) => console.error('[fair] failed to persist game seeds', err));
          }
          return hands;
        }
      : undefined;

    const started = this.rooms.startMatch(roomId, dealFn);
    if (!started.ok) {
      // The room changed during the escrow await (a player left → not full). The
      // pot was already escrowed, so refund it rather than leaking the stakes.
      if (escrowed && this.money) await this.money.refund(matchId);
      for (const s of room.seats) if (s.userId) this.rooms.setReady(s.userId, false);
      this.broadcastRoomState(roomId);
      return;
    }
    const state = this.roomStateWithCountdown(roomId);
    if (state) this.io.to(roomId).emit('match:start', state);
    if (fair) {
      this.fairByRoom.set(roomId, fair); // commit was already emitted at countdown start
      this.pendingServerSeeds.delete(roomId);
    }
    this.startNewGameBroadcast(roomId); // arms the turn timer before broadcasting
    this.broadcastLobby();
  }

  private clearCountdown(roomId: string): void {
    const h = this.countdowns.get(roomId);
    if (h) {
      clearTimeout(h);
      this.countdowns.delete(roomId);
    }
    this.countdownDeadlines.delete(roomId);
    this.pendingServerSeeds.delete(roomId); // abandon the committed-but-unused seed
  }

  /** Room DTO with the live ready-check countdown (ms remaining) overlaid. */
  private roomStateWithCountdown(roomId: string): ReturnType<RoomManager['roomStateDTO']> {
    const state = this.rooms.roomStateDTO(roomId);
    if (!state) return state;
    const deadline = this.countdownDeadlines.get(roomId);
    state.countdownMs = deadline !== undefined ? Math.max(0, deadline - Date.now()) : null;
    return state;
  }

  // ---------- Result -> emissions --------------------------------------------

  private applyResult(roomId: string, res: MatchActionResult): void {
    for (const ev of res.gameEvents) {
      if (ev.kind === 'trickWon') this.io.to(roomId).emit('game:trickWon', { winner: ev.winner, leadsNext: ev.leadsNext });
      else if (ev.kind === 'playerFinished') this.io.to(roomId).emit('game:playerFinished', { seat: ev.seat, place: ev.place });
    }

    for (const ev of res.matchEvents) {
      switch (ev.kind) {
        case 'gameScored': {
          const sb = this.rooms.scoreboardDTO(roomId);
          this.io.to(roomId).emit('game:end', {
            gameIndex: ev.index,
            finishingOrder: ev.finishingOrder,
            points: ev.points,
            scoreboard: sb!,
          });
          if (sb) this.io.to(roomId).emit('match:scoreboard', sb);
          break;
        }
        case 'targetExtended': {
          const sb = this.rooms.scoreboardDTO(roomId);
          if (sb) this.io.to(roomId).emit('match:scoreboard', sb);
          break;
        }
        case 'cardSwitchAuto':
          // Loser's strongest card was just moved to the winner: refresh BOTH
          // private hands so neither board is stale during the switch window.
          this.pushHand(roomId, ev.loser);
          this.pushHand(roomId, ev.winner);
          this.emitCardSwitch(roomId, { winner: ev.winner, loser: ev.loser, given: ev.card, returned: null, awaitingReturn: true });
          break;
        case 'awaitingSwitch': {
          // The winner must choose a 3–10 card to return — prompt them privately.
          const winnerU = this.userAtSeat(roomId, ev.winner);
          if (winnerU) {
            this.io.to(personalRoom(winnerU)).emit('card:switch', {
              winner: ev.winner, loser: ev.loser, given: null, returned: null, awaitingReturn: true,
            });
          }
          break;
        }
        case 'cardSwitchReturn':
          this.emitCardSwitch(roomId, { winner: ev.winner, loser: ev.loser, given: null, returned: ev.card, awaitingReturn: false });
          break;
        case 'gameStarted':
          this.startNewGameBroadcast(roomId);
          break;
        case 'matchEnded':
          // Settle the pot (pay winners, book rake), then emit the result.
          void this.settleAndEmitMatchEnd(roomId, ev.winnerSide, ev.winnerSeats, ev.finalSideScores);
          break;
      }
    }

    // Refresh public state and (re)arm the turn timer, unless the match ended.
    const room = this.rooms.getRoom(roomId);
    if (room && room.status === 'inMatch') {
      this.broadcastPublicState(roomId);
      this.armTurnTimer(roomId);
    } else {
      // Match ended normally: stop the turn timer and any pending forfeit timers
      // (a player who disconnected mid-match no longer abandons a finished match).
      this.clearTurnTimer(roomId);
      this.clearRoomAbandonTimers(roomId);
      this.broadcastLobby();
    }
    this.broadcastRoomState(roomId);
  }

  /** Deal-time broadcast: each player gets their own hand; everyone gets counts. */
  private startNewGameBroadcast(roomId: string): void {
    const room = this.rooms.getRoom(roomId);
    // Arm the turn timer FIRST so the dealt state carries a live deadline.
    this.armTurnTimer(roomId);
    const pub = this.rooms.publicGameDTO(roomId, this.deadlineFor(roomId));
    if (!room || !room.match || !pub) return;
    const gameIndex = room.match.snapshot().gameIndex;
    for (let seat = 0; seat < room.seats.length; seat++) {
      const userId = this.userAtSeat(roomId, seat);
      if (!userId) continue;
      const hand = this.rooms.handOf(roomId, seat);
      if (!hand) continue;
      this.io.to(personalRoom(userId)).emit('game:start', {
        yourSeat: seat,
        hand: [...hand],
        leader: pub.turn ?? 0,
        state: pub,
        gameIndex,
      });
    }
    this.broadcastPublicState(roomId);
  }

  private emitCardSwitch(roomId: string, dto: CardSwitchDTO): void {
    // The two participants get the FULL reveal (their own exchanged cards). Every
    // other seat gets an explicitly redacted copy (identities withheld) — addressed
    // per-seat so the no-leak guarantee never depends on socket-room membership.
    const room = this.rooms.getRoom(roomId);
    if (!room) return;
    const redacted: CardSwitchDTO = { ...dto, given: null, returned: null };
    for (let seat = 0; seat < room.seats.length; seat++) {
      const userId = this.userAtSeat(roomId, seat);
      if (!userId) continue;
      const payload = seat === dto.winner || seat === dto.loser ? dto : redacted;
      this.io.to(personalRoom(userId)).emit('card:switch', payload);
    }
  }

  // ---------- Social --------------------------------------------------------

  private async onInvite(socket: IOSocket, payload: { friendUserId: string }, ack: (res: Ack) => void): Promise<void> {
    const userId = socket.data.userId;
    if (!this.limiter.allow(userId)) return ack(ackError('rate', 'Shumë veprime — prit pak.'));
    const room = this.rooms.roomOf(userId);
    if (!room) return ack(ackError('no_room', 'Nuk je në një dhomë.'));
    const friendId = payload?.friendUserId;
    if (typeof friendId !== 'string' || !friendId) return ack(ackError('bad_request', 'Mik i pavlefshëm.'));
    if (this.friends && !(await this.friends.areFriends(userId, friendId))) {
      return ack(ackError('not_friends', 'Mund të ftosh vetëm miqtë.'));
    }
    this.io.to(personalRoom(friendId)).emit('invited', {
      roomId: room.id, fromUsername: socket.data.username, type: room.type, stakeCents: room.stakeCents,
    });
    ack({ ok: true });
  }

  /**
   * Award cosmetic XP/stats for a finished match. Isolated and fire-and-forget —
   * a failure here can NEVER affect settlement, scoring, or the rules engine.
   */
  private recordMatchStats(roomId: string, winnerSeats: number[]): void {
    if (!this.profiles) return;
    const room = this.rooms.getRoom(roomId);
    if (!room) return;
    const winSet = new Set(winnerSeats);
    const potCents = room.stakeCents * room.seats.filter((s) => s.userId).length;
    const seats = room.seats
      .map((s, i) => ({ userId: s.userId, i }))
      .filter((x): x is { userId: string; i: number } => x.userId !== null)
      .map((x) => ({ userId: x.userId, won: winSet.has(x.i), potCents }));
    void this.profiles.recordMatch(seats).catch(() => undefined);
  }

  // ---------- Settlement & forfeit -------------------------------------------

  /**
   * Synchronously claim a match for finalization — exactly once per match. Both a
   * normal end and a forfeit (or two forfeits) can target the same match: a
   * normal end has already flipped room.status to 'finished' (RoomManager does it
   * when the match reaches matchOver), while a forfeit fires while it's still
   * 'inMatch'. So we key the claim on the unique matchId, NOT room.status, and
   * record it in a set BEFORE any await — the first caller wins, the rest bail.
   * This prevents a double match:end and double-counted cosmetic XP.
   */
  private claimFinalize(roomId: string): boolean {
    const key = this.rooms.matchIdOf(roomId) ?? roomId;
    if (this.finalizedMatches.has(key)) return false;
    this.finalizedMatches.add(key);
    this.rooms.markFinished(roomId); // idempotent (may already be 'finished')
    return true;
  }

  /** Settle the pot for a normally-finished match, then broadcast match:end. */
  private async settleAndEmitMatchEnd(
    roomId: string,
    winnerSide: number,
    winnerSeats: number[],
    finalSideScores: number[],
  ): Promise<void> {
    if (!this.claimFinalize(roomId)) return; // already finalized by a racing forfeit
    let payoutCents: number | null = null;
    const matchId = this.rooms.matchIdOf(roomId);
    if (this.money && matchId) {
      const settlement = await this.money.settle({ matchId, winnerSeats });
      if (settlement) payoutCents = settlement.payouts.reduce((a, p) => a + p.amountCents, 0);
    }
    this.recordMatchStats(roomId, winnerSeats); // cosmetic XP/stats (isolated)
    this.clearRoomStrikes(roomId);
    const sb = this.rooms.scoreboardDTO(roomId);
    if (!sb) return;
    this.io.to(roomId).emit('match:end', { winnerSide, winnerSeats, finalSideScores, scoreboard: sb, payoutCents });
    this.revealFair(roomId);
  }

  /** Publish the serverSeed so players can verify every deal, then drop it. */
  private revealFair(roomId: string): void {
    const fair = this.fairByRoom.get(roomId);
    if (fair) {
      const matchId = this.rooms.matchIdOf(roomId);
      this.io.to(roomId).emit('fair:reveal', { ...fair.reveal(), matchId: matchId ?? undefined });
      // Publish the persisted seeds (revealed=true) so the durable audit endpoint
      // can serve them even to players who already disconnected.
      if (this.games && matchId) {
        void this.games.revealMatch(matchId).catch((err) => console.error('[fair] failed to reveal persisted games', err));
      }
      this.fairByRoom.delete(roomId);
    }
  }

  private startAbandonTimer(roomId: string, userId: string): void {
    this.clearAbandonTimer(userId);
    const handle = setTimeout(() => void this.onAbandon(roomId, userId), this.abandonMs);
    this.abandonTimers.set(userId, handle);
  }

  private clearAbandonTimer(userId: string): void {
    const h = this.abandonTimers.get(userId);
    if (h) clearTimeout(h);
    this.abandonTimers.delete(userId);
  }

  /** Grace expired and the player is still gone: forfeit the match. */
  private async onAbandon(roomId: string, userId: string): Promise<void> {
    this.abandonTimers.delete(userId);
    if (this.socketCountFor(userId) > 0) return; // reconnected in time
    const seat = this.rooms.seatOf(roomId, userId);
    if (seat < 0) return;
    await this.forfeitMatch(roomId, seat);
  }

  /**
   * End an in-progress match because `abandonerSeat` left/abandoned. The pot
   * (minus rake) goes to the other side — unless NO winner-side player is still
   * connected (everyone bailed), in which case the match is voided and all
   * stakes refunded. Idempotent: only acts while the room is still in-match.
   */
  private async forfeitMatch(roomId: string, abandonerSeat: number): Promise<void> {
    const room = this.rooms.getRoom(roomId);
    if (!room || !this.claimFinalize(roomId)) return; // bail if already finalized

    const players = room.seats
      .map((s, i) => ({ seat: i, userId: s.userId }))
      .filter((p): p is { seat: number; userId: string } => p.userId !== null);
    const winners = forfeitWinners(room.type, players, abandonerSeat, DEFAULT_TEAMS);
    const anyWinnerConnected = winners.some((s) => room.seats[s]?.connected);

    this.clearTurnTimer(roomId);
    this.clearRoomAbandonTimers(roomId);
    this.clearRoomStrikes(roomId);

    let payoutCents: number | null = null;
    let winnerSeats = winners;
    const matchId = this.rooms.matchIdOf(roomId);
    if (this.money && matchId) {
      if (anyWinnerConnected) {
        const settlement = await this.money.settle({ matchId, winnerSeats: winners });
        if (settlement) payoutCents = settlement.payouts.reduce((a, p) => a + p.amountCents, 0);
      } else {
        // No one left to take the pot — void the match and refund every stake.
        await this.money.refund(matchId);
        winnerSeats = [];
      }
    }
    this.recordMatchStats(roomId, winnerSeats); // cosmetic XP/stats (isolated)
    // (room already flipped to 'finished' synchronously by claimFinalize)

    const sb = this.rooms.scoreboardDTO(roomId);
    const winnerSide =
      winnerSeats.length === 0 ? -1 : room.type === '2v2' ? (DEFAULT_TEAMS[0].includes(winnerSeats[0]) ? 0 : 1) : winnerSeats[0];
    this.io.to(roomId).emit('match:end', {
      winnerSide,
      winnerSeats,
      finalSideScores: sb?.cumulative ?? [],
      scoreboard: sb ?? { type: room.type, target: room.target, cumulative: [], teamTotals: null },
      payoutCents,
    });
    // Tell only the NON-winners why the match ended — never the winners, whose
    // victory overlay must not be covered by a red "opponent left" error toast.
    for (const p of players) {
      if (winnerSeats.includes(p.seat)) continue;
      this.io.to(personalRoom(p.userId)).emit('error', { code: 'opponent_left', message: 'Një lojtar u largua — ndeshja u mbyll.' });
    }
    this.revealFair(roomId);
    this.broadcastLobby();
  }

  private clearRoomAbandonTimers(roomId: string): void {
    const room = this.rooms.getRoom(roomId);
    if (!room) return;
    for (const s of room.seats) if (s.userId) this.clearAbandonTimer(s.userId);
  }

  /** Reset every seated player's AFK (idle-timeout) counter for this room. */
  private clearRoomStrikes(roomId: string): void {
    const room = this.rooms.getRoom(roomId);
    if (!room) return;
    for (const s of room.seats) if (s.userId) this.idleStrikes.delete(s.userId);
  }

  // ---------- Turn timer ------------------------------------------------------

  private armTurnTimer(roomId: string): void {
    this.clearTurnTimer(roomId);
    const room = this.rooms.getRoom(roomId);
    if (room?.status !== 'inMatch' || !room.match) return;
    const snap = room.match.snapshot();

    // Between games, the winner must return a 3–10 card. Give them the same
    // turn budget; on timeout we auto-return their weakest eligible card so a
    // match can NEVER hang waiting on the switch (real money is at stake).
    if (snap.pendingSwitch) {
      const winnerSeat = snap.pendingSwitch.winner;
      this.turnDeadlines.set(roomId, Date.now() + this.turnMs);
      const handle = setTimeout(() => this.onSwitchTimeout(roomId, winnerSeat), this.turnMs);
      this.turnTimers.set(roomId, handle);
      return;
    }

    const turn = snap.game?.turn;
    if (turn === null || turn === undefined) return;
    this.turnDeadlines.set(roomId, Date.now() + this.turnMs);
    const handle = setTimeout(() => this.onTurnTimeout(roomId, turn), this.turnMs);
    this.turnTimers.set(roomId, handle);
  }

  /**
   * Switch timeout: the winner did not return a card in time. Auto-return their
   * WEAKEST eligible 3–10 card (the natural choice — keep the strong cards) so
   * the next game starts. Repeated misses still count toward the idle forfeit.
   */
  private onSwitchTimeout(roomId: string, seat: number): void {
    const room = this.rooms.getRoom(roomId);
    if (!room?.match || room.status !== 'inMatch') return;
    if (room.match.snapshot().pendingSwitch?.winner !== seat) return; // already resolved
    const userId = this.userAtSeat(roomId, seat);
    if (!userId) return;

    const strikes = (this.idleStrikes.get(userId) ?? 0) + 1;
    this.idleStrikes.set(userId, strikes);
    if (strikes >= IDLE_FORFEIT_STRIKES) {
      this.idleStrikes.delete(userId);
      void this.forfeitMatch(roomId, seat);
      return;
    }

    const eligible = room.match.eligibleReturnCardsForWinner();
    if (eligible.length === 0) { this.armTurnTimer(roomId); return; }
    const weakest = [...eligible].sort((a, b) => singlePower(a) - singlePower(b))[0];
    const res = this.rooms.switchGive(userId, weakest);
    if (res.ok && res.roomId) this.applyResult(res.roomId, res);
    else this.armTurnTimer(roomId);
  }

  private clearTurnTimer(roomId: string): void {
    const h = this.turnTimers.get(roomId);
    if (h) clearTimeout(h);
    this.turnTimers.delete(roomId);
    this.turnDeadlines.delete(roomId);
  }

  private deadlineFor(roomId: string): number | null {
    return this.turnDeadlines.get(roomId) ?? null;
  }

  /** On timeout: a responder auto-passes; a leader auto-plays a forced legal lead. */
  private onTurnTimeout(roomId: string, seat: number): void {
    const room = this.rooms.getRoom(roomId);
    if (!room || !room.match || room.status !== 'inMatch') return;
    const snap = room.match.snapshot().game;
    if (!snap || snap.turn !== seat) return; // turn already moved on
    const userId = this.userAtSeat(roomId, seat);
    if (!userId) return;

    // Count this missed turn; after IDLE_FORFEIT_STRIKES in a row the player is
    // treated as abandoning — end the match and award the pot to the active side.
    const strikes = (this.idleStrikes.get(userId) ?? 0) + 1;
    this.idleStrikes.set(userId, strikes);
    if (strikes >= IDLE_FORFEIT_STRIKES) {
      this.idleStrikes.delete(userId);
      void this.forfeitMatch(roomId, seat);
      return;
    }

    let res: MatchActionResult & { roomId?: string };
    if (snap.pile === null) {
      res = this.forcedLead(roomId, userId, seat);
    } else {
      res = this.rooms.pass(userId);
    }
    if (res.ok && res.roomId) {
      this.applyResult(res.roomId, res);
      // The player didn't initiate this move, so their client never optimistically
      // removed the auto-played card — push their authoritative hand so the card
      // disappears from their display (otherwise replaying it errors).
      if (this.rooms.getRoom(roomId)?.status === 'inMatch') this.pushHand(roomId, seat);
    } else {
      this.armTurnTimer(roomId); // nothing legal happened; re-arm defensively
    }
  }

  /** Choose a legal forced lead. If the game still requires an opening card
   *  (e.g. 3♠ in game 1), lead exactly that — a valid single that satisfies the
   *  "must include" rule — rather than relying on it being the lowest single.
   *  Otherwise lead the lowest single the engine will accept. */
  private forcedLead(roomId: string, userId: string, seat: number): MatchActionResult & { roomId?: string } {
    const hand = this.rooms.handOf(roomId, seat);
    if (!hand) return { ok: false, reason: 'no forced move', gameEvents: [], matchEvents: [] };

    const opening = this.rooms.getRoom(roomId)?.match?.snapshot().game?.openingCard ?? null;
    if (opening) {
      const res = this.rooms.play(userId, [opening]); // opening lead must include this card
      if (res.ok) return res;
    }
    const singles = [...hand].sort((a, b) => singlePower(a) - singlePower(b));
    for (const card of singles) {
      const res = this.rooms.play(userId, [card]);
      if (res.ok) return res;
    }
    return { ok: false, reason: 'no forced move', gameEvents: [], matchEvents: [] };
  }

  // ---------- Broadcast helpers ----------------------------------------------

  private broadcastLobby(): void {
    this.io.emit('lobby:state', this.rooms.listLobby());
  }

  private broadcastRoomState(roomId: string): void {
    const state = this.roomStateWithCountdown(roomId);
    if (state) this.io.to(roomId).emit('room:state', state);
  }

  /** Push a single seat's private hand to its own socket(s). */
  private pushHand(roomId: string, seat: number): void {
    const userId = this.userAtSeat(roomId, seat);
    const hand = this.rooms.handOf(roomId, seat);
    if (userId && hand) this.io.to(personalRoom(userId)).emit('game:hand', { yourSeat: seat, hand: [...hand] });
  }

  private broadcastPublicState(roomId: string): void {
    const pub = this.rooms.publicGameDTO(roomId, this.deadlineFor(roomId));
    if (!pub) return;
    this.io.to(roomId).emit('game:state', pub);
    if (pub.turn !== null) {
      const userId = this.userAtSeat(roomId, pub.turn);
      if (userId) this.io.to(personalRoom(userId)).emit('game:yourTurn', pub);
    }
  }

  /** Push a complete, private-safe state to a single (re)connecting socket. */
  private pushFullStateTo(socket: IOSocket): void {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const roomState = this.roomStateWithCountdown(roomId);
    if (roomState) socket.emit('room:state', roomState);

    const room = this.rooms.getRoom(roomId);
    if (!room || !room.match || room.status !== 'inMatch') return;
    const seat = this.rooms.seatOf(roomId, socket.data.userId);
    const snap = room.match.snapshot();
    const hand = seat >= 0 ? this.rooms.handOf(roomId, seat) : null;
    const pub = this.rooms.publicGameDTO(roomId, this.deadlineFor(roomId));

    if (pub && hand) {
      socket.emit('game:start', {
        yourSeat: seat,
        hand: [...hand],
        leader: pub.turn ?? 0,
        state: pub,
        gameIndex: snap.gameIndex,
      });
    } else if (snap.pendingSwitch && hand) {
      // Reconnecting between games during the card switch: re-deliver the private
      // hand, plus a card:switch so the client restores switch UI. The winner
      // (winner===seat) gets the "choose a card" prompt; everyone else gets the
      // "opponent is choosing" notice — the client keys that off winner===mySeat,
      // so the same redacted payload serves both.
      socket.emit('game:hand', { yourSeat: seat, hand: [...hand] });
      socket.emit('card:switch', {
        winner: snap.pendingSwitch.winner,
        loser: snap.pendingSwitch.loser,
        given: null,
        returned: null,
        awaitingReturn: true,
      });
    }
    const sb = this.rooms.scoreboardDTO(roomId);
    if (sb) socket.emit('match:scoreboard', sb);
  }

  // ---------- Small utilities -------------------------------------------------

  private leaveAndNotify(userId: string, roomId: string): void {
    const before = this.rooms.getRoom(roomId);
    const wasInMatch = before?.status === 'inMatch';
    const result = this.rooms.leaveRoom(userId);
    if (result.roomClosed) {
      this.clearCountdown(roomId);
      this.clearTurnTimer(roomId);
    } else {
      this.broadcastRoomState(roomId);
      this.maybeStartCountdown(roomId);
    }
    this.broadcastLobby();
    void wasInMatch; // abandon/forfeit settlement is Phase 6
  }

  private userAtSeat(roomId: string, seat: number): string {
    const room = this.rooms.getRoom(roomId);
    return room?.seats[seat]?.userId ?? '';
  }

  private socketCountFor(userId: string): number {
    const room = this.io.sockets.adapter.rooms.get(personalRoom(userId));
    return room ? room.size : 0;
  }
}

function personalRoom(userId: string): string {
  return `u:${userId}`;
}
function actor(socket: IOSocket): { userId: string; username: string } {
  return { userId: socket.data.userId, username: socket.data.username };
}
