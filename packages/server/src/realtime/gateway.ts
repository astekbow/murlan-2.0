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
  CardSwitchDTO, MatchType, RankedDeltaDTO,
} from '@murlan/shared';
import { PLAYERS_PER_TYPE } from '@murlan/shared';
import type { RoomManager } from '../room/roomManager.ts';
import type { MatchActionResult } from '../match/match.ts';
import type { AuthService } from '../auth/authService.ts';
import type { MoneyService } from '../money/moneyService.ts';
import { createFairShuffle, combineClientSeeds, generateServerSeed, sha256Hex, type FairShuffle } from '../fair/provablyFair.ts';
import type { GamesRepository } from '../fair/gamesRepository.ts';
import type { MatchActionsRepository, MatchActionType } from './matchActions.ts';
import { MatchmakingService, type QueueEntry } from './matchmaking.ts';
import { RateLimiter } from '../util/rateLimiter.ts';
import { TimerOrchestrator } from './timerOrchestrator.ts';
import { isCardArray, isValidCard, isMatchType, isTeam, isValidStake, isNonEmptyString } from './validation.ts';
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';
import type { ProfileService } from '../profile/profileService.ts';
import type { FriendsService } from '../social/friendsService.ts';
import type { ClubService } from '../social/clubService.ts';
import type { Presence } from './presence.ts';
import type { RankedService } from '../ranked/rankedService.ts';
import type { AntiCheatService } from '../antiCheat/antiCheatService.ts';
import type { PushService } from '../push/pushService.ts';
import type { ChatService } from '../chat/chatService.ts';
import type { TournamentService } from '../tournament/tournamentService.ts';
import { decideBotMove, type BotTier } from '../bot/botDecision.ts';
import { settlementFailures, socketConnections, settlementDuration } from '../metrics.ts';
import type { RoomOwnership } from './roomOwnership.ts';
import { personalRoom, clubRoom, LEADERBOARD_ROOM, isBot, BOT_PREFIX, pickGhostNames, BOT_MIN_DELAY, BOT_MAX_DELAY } from './gatewayHelpers.ts';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface GatewayOptions {
  turnMs?: number;       // per-turn timer; default 30s
  countdownMs?: number;  // ready-check countdown before a match starts; default 3s
  rematchMs?: number;    // how long a rematch offer stays open for everyone to opt in; default 20s
  handPauseMs?: number;  // inter-hand standings pause before the next hand deals; default 0 (off — prod wires it via config); 0 = immediate
  money?: MoneyService;  // when present, stakes are escrowed/settled (Phase 6)
  rakeBps?: number;      // house rake in basis points; default 1000 (10%)
  abandonMs?: number;    // reconnection grace before a disconnect forfeits; default 30s
  provablyFair?: boolean; // use the commit-reveal shuffle (default true); tests disable to script deals
  compliance?: ComplianceService; // gates staked play (KYC/age/geo/self-exclusion) when enabled
  rg?: ResponsibleGamingService;  // gates staked play on the player's daily loss cap
  profiles?: ProfileService; // awards cosmetic XP/stats at match end (isolated; never affects money)
  ranked?: RankedService;    // updates MMR/season ladder at match end (isolated; competitive/cosmetic only)
  antiCheat?: AntiCheatService; // flags suspicious matches for manual review at match end (isolated)
  friends?: FriendsService;  // gates/handles friend room invites
  clubs?: ClubService;       // resolves the inviter's club for club invites (social only)
  presence?: Presence;       // tracks who is online (shared with the friends routes)
  games?: GamesRepository;   // persists provably-fair seeds per game (durable audit)
  matchLog?: MatchActionsRepository; // persists the move-log for replay/dispute (isolated; never blocks play)
  matchmaking?: MatchmakingService;  // ranked skill-matched queue (requires `ranked` to rate the result)
  push?: PushService; // Web Push re-engagement nudges (isolated; never affects play)
  chat?: ChatService; // club chat (membership-gated, rate-limited, mute-aware)
  tournaments?: TournamentService; // runs tournament-bracket pairings as live matches (self-running)
  botDelayMs?: number; // practice-bot "thinking" delay (ms); injectable for deterministic tests
  ghostFillMs?: number; // free-lobby auto-fill delay (ms); injectable for deterministic tests
  isDraining?: () => boolean; // graceful shutdown: reject NEW matches/queue joins while true
  ownership?: RoomOwnership; // multi-instance room-ownership registry (single-instance no-op)
  rateLimiter?: RateLimiter; // per-user intent bucket (default 40 burst / 20-per-sec); injectable for tests
}

const ackError = (code: string, message: string): Ack => ({ ok: false, error: { code, message } });

// A hostile/buggy client may emit an intent with no ack callback. Calling a
// missing ack throws (and would leave the handler half-run); wrap it so a reply
// is always safe to call and never throws.
function safeAck(ack: unknown): (res: Ack) => void {
  return typeof ack === 'function' ? (ack as (res: Ack) => void) : () => {};
}

// A player who lets this many of their OWN turns time out in a row (never acts) is
// removed from the match for inactivity (auto-passed/placed last, stake forfeited); the
// still-active side plays on / wins the pot. Resets on any real move (play/pass/switch).
const IDLE_FORFEIT_STRIKES = 3;

// Cap spectators per room so a flood of watchers can't blow up broadcast fan-out.
const SPECTATOR_CAP = 100;

// A FREE (zero-stake) room that hasn't filled with humans this long auto-fills with
// fill-players so the host never sits in an empty lobby. Humans always get priority:
// if they join first the timer is cancelled. NEVER applies to staked rooms.
const GHOST_FILL_MS = 12_000;

/** Result of an admin match-void (see GameGateway.adminVoidMatch). */
export type AdminVoidResult =
  | { ok: true; matchId: string | null; refunded: boolean }
  | { ok: false; reason: 'not_found' | 'not_in_match' | 'already_finalized' };

export class GameGateway {
  private readonly turnMs: number;
  private readonly countdownMs: number;
  private readonly rematchMs: number;
  private readonly handPauseMs: number;
  private readonly money: MoneyService | null;
  private readonly rakeBps: number;
  private readonly abandonMs: number;
  private readonly provablyFair: boolean;
  private readonly compliance: ComplianceService | null;
  private readonly rg: ResponsibleGamingService | null;
  private readonly profiles: ProfileService | null;
  private readonly ranked: RankedService | null;
  private readonly antiCheat: AntiCheatService | null;
  private readonly friends: FriendsService | null;
  private readonly clubs: ClubService | null;
  private readonly presence: Presence | null;
  private readonly games: GamesRepository | null;
  private readonly matchLog: MatchActionsRepository | null;
  private readonly push: PushService | null;
  private readonly chat: ChatService | null;
  private readonly tournaments: TournamentService | null;
  // Tournament pairing → its live room id, so we never spin up two rooms for the
  // same bracket match (and can clean up on result). Key: `${tid}:${round}:${index}`.
  private tournamentMatchRooms = new Map<string, string>();
  // Per tournament-room no-show timers: if a paired player never joins, the match
  // is walked over to whoever did, so the bracket can't stall. roomId → timer.
  private tournamentNoShowTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Rematch offers: roomId → who has opted in + the window deadline (epoch ms), plus the
  // timer that cancels the offer if consensus isn't reached in time.
  private rematchAccepts = new Map<string, { users: Set<string>; deadline: number }>();
  private rematchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // How long to wait for both paired players to join before a walkover (ms).
  private readonly tournamentJoinMs = 45_000;
  private readonly botDelayMs: number | null;
  private readonly isDraining: () => boolean;
  private readonly ownership: RoomOwnership | null;
  private readonly matchmaking: MatchmakingService | null;
  // Per-match monotonic action counter (turn order for the move-log). Assigned
  // synchronously so ordering is correct regardless of async write timing; the
  // entry is dropped when the match finalizes.
  private matchActionSeq = new Map<string, number>();
  // Spectators per room (count only; identity not needed). Bounded by SPECTATOR_CAP.
  private spectatorCount = new Map<string, number>();
  // All scheduled timers (countdown / turn / abandon) + their deadlines live here.
  private readonly timers = new TimerOrchestrator();
  private idleStrikes = new Map<string, number>(); // userId -> consecutive turn timeouts (reset on any real move)
  private botTiers = new Map<string, BotTier>(); // practice roomId -> bot difficulty
  private botTimers = new Map<string, ReturnType<typeof setTimeout>>(); // practice roomId -> pending bot-move timer
  // Inter-hand pause gate: between hands the next deal is held briefly so players can
  // see the final play + the standings; it releases EARLY once every connected human
  // has tapped Continue, else on the timer. roomId -> { timer, who's-ready, release }.
  private interHandGates = new Map<string, { timer: ReturnType<typeof setTimeout>; ready: Set<number>; release: () => void }>();
  private ghostFillTimers = new Map<string, ReturnType<typeof setTimeout>>(); // free roomId -> pending auto-fill timer
  private readonly ghostFillMs: number;
  private seenCards = new Map<string, Card[]>(); // practice roomId -> cards played this game (bot card-counting)
  private finalizedMatches = new Set<string>(); // matchIds whose match:end has been emitted (exactly-once finalize)
  private fairByRoom = new Map<string, FairShuffle>(); // provably-fair shuffle per active match
  private pendingServerSeeds = new Map<string, string>(); // roomId -> serverSeed committed at countdown start
  private clientSeeds = new Map<string, string>(); // userId -> clientSeed (submitted AFTER the commit)
  // Per-user token bucket: 40 burst, 20/s sustained — ample for real play, caps abuse.
  private readonly limiter: RateLimiter;
  // Dedicated, MUCH tighter bucket for room join-by-code: ~6 attempts then 1 every 5s,
  // so the short share codes can't be brute-force enumerated (the general limiter at
  // 40 burst / 20-per-sec is far too loose for guessing). Keyed by userId.
  private readonly joinCodeLimiter = new RateLimiter(6, 0.2);
  // Connection-flood defense for the handshake (auth correctness unchanged). A
  // connect-flood would otherwise hit the DB twice per (re)connect (account-state +
  // profile). (1) A short cache of the per-user handshake reads dedupes a burst; (2) a
  // per-(userId+IP) connection-rate guard rejects an abusive reconnect storm.
  private readonly handshakeCache = new Map<string, { at: number; ver: number; allowed: boolean; code?: string; avatar: string | null }>();
  private readonly handshakeRate = new Map<string, { count: number; windowStart: number }>();
  private static readonly HANDSHAKE_CACHE_MS = 3_000;   // re-read account-state/profile at most ~every 3s/user
  private static readonly HANDSHAKE_MAX_PER_WINDOW = 30; // connections per (userId+IP) per window
  private static readonly HANDSHAKE_WINDOW_MS = 10_000;  // 10s window

  constructor(
    private readonly io: IO,
    private readonly rooms: RoomManager,
    private readonly auth: AuthService,
    opts: GatewayOptions = {},
  ) {
    this.turnMs = opts.turnMs ?? 30_000;
    this.countdownMs = opts.countdownMs ?? 3_000;
    this.rematchMs = opts.rematchMs ?? 20_000;
    this.handPauseMs = opts.handPauseMs ?? 0; // off unless wired (prod sets it via config); keeps tests deterministic
    this.money = opts.money ?? null;
    this.rakeBps = opts.rakeBps ?? 1_000;
    this.abandonMs = opts.abandonMs ?? 30_000;
    this.provablyFair = opts.provablyFair ?? true;
    this.compliance = opts.compliance ?? null;
    this.rg = opts.rg ?? null;
    this.profiles = opts.profiles ?? null;
    this.ranked = opts.ranked ?? null;
    this.antiCheat = opts.antiCheat ?? null;
    this.friends = opts.friends ?? null;
    // Real-time friend-request pings: push to the recipient's personal room so the
    // client can pop a 🔔 notification (best-effort — no-op if they're offline).
    this.friends?.setNotifier((targetUserId, fromUsername) => {
      this.io.to(personalRoom(targetUserId)).emit('friend:request', { fromUsername });
    });
    // Tell a user their friends list changed (request answered / unfriended) so their open
    // Friends page reloads instantly instead of waiting up to 8s for the next poll.
    this.friends?.setSocialNotifier((userId) => {
      this.io.to(personalRoom(userId)).emit('social:refresh');
    });
    this.clubs = opts.clubs ?? null;
    this.presence = opts.presence ?? null;
    this.games = opts.games ?? null;
    this.matchLog = opts.matchLog ?? null;
    this.push = opts.push ?? null;
    this.chat = opts.chat ?? null;
    this.tournaments = opts.tournaments ?? null;
    this.botDelayMs = opts.botDelayMs ?? null;
    this.ghostFillMs = opts.ghostFillMs ?? GHOST_FILL_MS;
    this.isDraining = opts.isDraining ?? (() => false);
    this.ownership = opts.ownership ?? null;
    // Matchmaking needs MMR ratings to bracket players, so it's only active when
    // the ranked service is also present.
    this.matchmaking = this.ranked ? (opts.matchmaking ?? new MatchmakingService()) : null;
    this.limiter = opts.rateLimiter ?? new RateLimiter(40, 20);
    this.registerAuth();
    this.io.on('connection', (socket) => this.onConnection(socket));
  }

  // ---------- Auth handshake --------------------------------------------------

  private registerAuth(): void {
    this.io.use(async (socket, next) => {
      const token = (socket.handshake.auth?.token ?? socket.handshake.headers?.authorization?.replace(/^Bearer /, '')) as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      try {
        const { userId, username, ver } = this.auth.verifyAccess(token);
        // Connection-rate guard: cap (re)connects per (userId + client IP) so a connect
        // flood can't hammer the DB or churn sockets. Verified-token only (no anon flood).
        const ip = socket.handshake.address || 'unknown';
        if (!this.allowHandshake(`${userId}|${ip}`)) return next(new Error('rate_limited'));
        // Revocation-aware account-state gate: reject when the token's tokenVersion is
        // stale (force-logout / ban / reset / logout-all bumped it — socket-1/auth-2) OR
        // login is blocked (banned/suspended; frozen still allowed). Plus the cosmetic
        // avatar. Both are DB reads → served from a short per-user cache, but the cache is
        // SKIPPED when `ver` changed so a just-revoked token can't ride a stale cached OK.
        const resolved = await this.resolveHandshake(userId, ver);
        if (!resolved.allowed) return next(new Error(resolved.code ?? 'blocked'));
        socket.data.userId = userId;
        socket.data.username = username;
        socket.data.avatar = resolved.avatar;
        socket.data.roomId = null;
        socket.data.seat = null;
        socket.data.clientSeed = null;
        socket.data.spectating = null;
        next();
      } catch {
        next(new Error('unauthorized'));
      }
    });
  }

  /** Per-(userId+IP) fixed-window connection-rate guard. Returns false when over cap. */
  private allowHandshake(key: string): boolean {
    const now = Date.now();
    const rec = this.handshakeRate.get(key);
    if (!rec || now - rec.windowStart >= GameGateway.HANDSHAKE_WINDOW_MS) {
      this.handshakeRate.set(key, { count: 1, windowStart: now });
      // Opportunistic prune so the map can't grow without bound under an IP/user spray.
      if (this.handshakeRate.size > 10_000) {
        for (const [k, v] of this.handshakeRate) if (now - v.windowStart >= GameGateway.HANDSHAKE_WINDOW_MS) this.handshakeRate.delete(k);
      }
      return true;
    }
    rec.count += 1;
    return rec.count <= GameGateway.HANDSHAKE_MAX_PER_WINDOW;
  }

  /** Resolve the per-user handshake reads (revocation-aware account-state gate + avatar)
   *  with a short TTL cache so a connect-burst doesn't issue two DB reads per socket. The
   *  cache is bypassed when the presented token's `ver` differs from the cached one, so a
   *  freshly-revoked (ver-bumped) token is never accepted on a stale cached OK. */
  private async resolveHandshake(userId: string, ver: number): Promise<{ allowed: boolean; code?: string; avatar: string | null }> {
    const cached = this.handshakeCache.get(userId);
    if (cached && cached.ver === ver && Date.now() - cached.at < GameGateway.HANDSHAKE_CACHE_MS) {
      return { allowed: cached.allowed, code: cached.code, avatar: cached.avatar };
    }
    // checkSession resolves the user ONCE: rejects a stale tokenVersion (revocation) AND a
    // blocked account-state in a single DB read (mirrors authorizeRequest for REST).
    const gate = await this.auth.checkSession(userId, ver);
    const avatar = gate.allowed && this.profiles ? ((await this.profiles.getProfile(userId).catch(() => null))?.avatar ?? null) : null;
    const entry = { at: Date.now(), ver, allowed: gate.allowed, code: gate.code, avatar };
    this.handshakeCache.set(userId, entry);
    if (this.handshakeCache.size > 10_000) {
      const cutoff = Date.now() - GameGateway.HANDSHAKE_CACHE_MS;
      for (const [k, v] of this.handshakeCache) if (v.at < cutoff) this.handshakeCache.delete(k);
    }
    return { allowed: gate.allowed, code: gate.code, avatar };
  }

  /** Force-disconnect every live socket for a user (e.g. when an admin bans/suspends
   *  them) so they can't keep playing on a still-valid access token. The auth
   *  middleware then refuses any reconnect while the account is blocked. */
  disconnectUser(userId: string): void {
    void this.io.in(personalRoom(userId)).disconnectSockets(true);
  }

  // ---------- Connection lifecycle -------------------------------------------

  private onConnection(socket: IOSocket): void {
    const { userId } = socket.data;
    socketConnections.inc();
    void socket.join(personalRoom(userId));
    this.presence?.add(userId);
    // Join the user's club channel so they receive live chat. (Membership change
    // via REST takes effect on the next (re)connect — acceptable for v1.)
    if (this.chat) void this.chat.clubIdFor(userId).then((cid) => { if (cid) void socket.join(clubRoom(cid)); }).catch(() => undefined);

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
    socket.on('room:joinByCode', (payload, ack) => this.onJoinByCode(socket, payload, ack));
    socket.on('room:leave', (ack) => void this.onLeave(socket, ack));
    socket.on('room:ready', (ready, ack) => this.onReady(socket, ready, ack));
    socket.on('room:rematch', (ack) => void this.onRematch(socket, ack));
    socket.on('game:play', (payload, ack) => this.onPlay(socket, payload, ack));
    socket.on('game:pass', (ack) => this.onPass(socket, ack));
    socket.on('game:switchGive', (payload, ack) => this.onSwitchGive(socket, payload, ack));
    socket.on('game:continue', () => this.onHandContinue(socket));
    socket.on('ranked:queue:join', (payload, ack) => void this.onRankedQueueJoin(socket, payload, ack));
    socket.on('ranked:queue:leave', (ack) => this.onRankedQueueLeave(socket, ack));
    socket.on('room:spectate', (payload, ack) => this.onSpectate(socket, payload, ack));
    socket.on('room:unspectate', (ack) => this.onUnspectate(socket, ack));
    // Leaderboard live view: join/leave the shared channel while the page is open
    // (idempotent; auto-cleaned on disconnect by Socket.IO). A finished match then
    // pushes a 'leaderboard:refresh' here for live rank movement.
    socket.on('leaderboard:watch', () => void socket.join(LEADERBOARD_ROOM));
    socket.on('leaderboard:unwatch', () => void socket.leave(LEADERBOARD_ROOM));
    socket.on('fair:clientSeed', (seed) => {
      if (!this.limiter.allow(socket.data.userId)) return;
      if (typeof seed === 'string' && seed.length > 0 && seed.length <= 128) {
        socket.data.clientSeed = seed;
        this.clientSeeds.set(socket.data.userId, seed);
      }
    });
    socket.on('auth', (token, ack) => void this.onReAuth(socket, token, ack));

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
    socket.on('club:invite', (payload, ack) => void this.onClubInvite(socket, payload, ack));
    socket.on('club:message', (payload, ack) => void this.onClubMessage(socket, payload, ack));
    socket.on('practice:start', (payload, ack) => this.onPracticeStart(socket, payload, ack));

    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  private onDisconnect(socket: IOSocket): void {
    const { userId } = socket.data;
    socketConnections.dec();
    this.removeSpectator(socket); // per-socket: free its spectator slot if watching
    // If other sockets for this user remain, keep state untouched.
    if (this.socketCountFor(userId) > 0) return;
    this.limiter.release(userId); // no sockets left — free the rate bucket
    this.clientSeeds.delete(userId); // don't carry a stale seed into a future match
    this.matchmaking?.remove(userId); // stop trying to matchmake a user who's gone
    this.presence?.remove(userId); // last socket gone — mark offline

    const room = this.rooms.roomOf(userId);
    if (!room) return;
    if (room.practice) {
      // Practice is ephemeral + zero-stake: end it immediately and remove the bots
      // (no reconnection grace — a solo practice table isn't worth holding open).
      this.leaveAndNotify(userId, room.id);
      this.teardownPractice(room.id);
    } else if (room.status === 'inMatch') {
      // Keep the seat for reconnection; mark offline and start the forfeit grace.
      this.rooms.setConnected(userId, false);
      this.broadcastRoomState(room.id);
      this.startAbandonTimer(room.id, userId);
    } else {
      // Not started yet — free the seat so the lobby stays clean.
      this.leaveAndNotify(userId, room.id);
    }
  }

  private async onReAuth(socket: IOSocket, token: string, ack: (res: Ack) => void): Promise<void> {
    if (!this.rateOk(socket, ack)) return;
    let userId: string;
    let username: string;
    let ver: number;
    try {
      ({ userId, username, ver } = this.auth.verifyAccess(token));
    } catch {
      return ack(ackError('unauthorized', 'Token i pavlefshëm.'));
    }
    // A connection may only REFRESH its own session, never rebind to a
    // different user (that would desync rooms/seats and could leak hands).
    if (userId !== socket.data.userId) {
      return ack(ackError('identity_mismatch', 'Nuk mund të ndryshosh identitetin e lidhjes.'));
    }
    // Revocation-aware re-auth (socket-1): a token that was force-logged-out/banned after
    // it was minted (stale `ver`) or now blocks login must be REJECTED here too — the
    // handshake guard alone would otherwise let a long-lived socket re-arm on a dead token.
    const gate = await this.auth.checkSession(userId, ver).catch(() => ({ allowed: false as const, code: 'unauthorized', message: 'Token i pavlefshëm.' }));
    if (!gate.allowed) {
      ack(ackError(gate.code ?? 'unauthorized', gate.message ?? 'Sesioni ka skaduar.'));
      // Drop the socket: its session is revoked/blocked, so it must not keep playing.
      this.disconnectUser(userId);
      return;
    }
    socket.data.username = username;
    ack({ ok: true });
  }

  // ---------- Intent handlers -------------------------------------------------

  /** Per-user rate gate for ack-based intents. Returns true if the call should proceed. */
  private rateOk(socket: IOSocket, ack: (res: Ack) => void): boolean {
    if (this.limiter.allow(socket.data.userId)) return true;
    ack(ackError('rate_limited', 'Shumë veprime — ngadalëso.'));
    return false;
  }

  /** During graceful shutdown, reject NEW matches/queue joins (existing matches finish). */
  private rejectIfDraining(reply: (res: Ack) => void): boolean {
    if (!this.isDraining()) return false;
    reply(ackError('draining', 'Serveri po përditësohet — provo sërish pas pak.'));
    return true;
  }

  private onCreate(socket: IOSocket, payload: RoomCreatePayload, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (this.rejectIfDraining(reply)) return;
    if (!payload || !isMatchType(payload.type) || !isValidStake(payload.stakeCents) || !isTeam(payload.team)) {
      return reply(ackError('bad_request', 'Kërkesë e pavlefshme për krijim dhome.'));
    }
    try {
      const res = this.rooms.createRoom(actor(socket), payload);
      if (!res.ok || !res.roomId) return reply({ ok: false, error: res.error });
      this.ownership?.claim(res.roomId); // this instance owns the new room
      this.matchmaking?.remove(socket.data.userId); // can't be queued AND in a room
      socket.data.roomId = res.roomId;
      socket.data.seat = this.rooms.seatOf(res.roomId, socket.data.userId);
      void socket.join(res.roomId);
      reply({ ok: true, roomId: res.roomId, joinCode: res.joinCode });
      this.broadcastRoomState(res.roomId);
      this.broadcastLobby();
      this.armGhostFill(res.roomId); // free public lobby → auto-fill with players if no humans join
    } catch (e) {
      console.error('[gateway] onCreate failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }

  /** Join a PRIVATE room by its share code (the room isn't in the public lobby). */
  private onJoinByCode(socket: IOSocket, payload: { code?: unknown }, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    // Extra anti-enumeration throttle specific to code guessing.
    if (!this.joinCodeLimiter.allow(socket.data.userId)) {
      return reply(ackError('rate', 'Shumë përpjekje me kod — prit pak.'));
    }
    if (this.rejectIfDraining(reply)) return;
    const code = typeof payload?.code === 'string' ? payload.code : '';
    const roomId = this.rooms.roomIdForCode(code);
    if (!roomId) return reply(ackError('not_found', 'Kodi i dhomës nuk u gjet.'));
    if (this.ownership?.isForeign(roomId)) {
      return reply(ackError('wrong_instance', 'Po të rilidhim me serverin e ndeshjes — provo sërish.'));
    }
    try {
      const res = this.rooms.joinRoom(actor(socket), roomId);
      if (!res.ok) return reply({ ok: false, error: res.error });
      this.matchmaking?.remove(socket.data.userId);
      socket.data.roomId = roomId;
      socket.data.seat = this.rooms.seatOf(roomId, socket.data.userId);
      void socket.join(roomId);
      reply({ ok: true, roomId });
      this.broadcastRoomState(roomId);
      this.broadcastLobby();
      this.maybeStartCountdown(roomId);
    } catch (e) {
      console.error('[gateway] onJoinByCode failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }

  private onJoin(socket: IOSocket, payload: RoomJoinPayload, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (this.rejectIfDraining(reply)) return;
    // Multi-instance: if another instance owns this room, this instance can't serve
    // it (authoritative state is instance-local) — reject so the client reconnects
    // and sticky routing lands them on the owner. No-op single-instance.
    if (payload && isNonEmptyString(payload.roomId) && this.ownership?.isForeign(payload.roomId)) {
      return reply(ackError('wrong_instance', 'Po të rilidhim me serverin e ndeshjes — provo sërish.'));
    }
    if (!payload || !isNonEmptyString(payload.roomId) || !isTeam(payload.team)) {
      return reply(ackError('bad_request', 'Kërkesë e pavlefshme për bashkim.'));
    }
    try {
      const res = this.rooms.joinRoom(actor(socket), payload.roomId, payload.team);
      if (!res.ok) return reply({ ok: false, error: res.error });
      this.matchmaking?.remove(socket.data.userId); // can't be queued AND in a room
      socket.data.roomId = payload.roomId;
      socket.data.seat = this.rooms.seatOf(payload.roomId, socket.data.userId);
      void socket.join(payload.roomId);
      // A tournament pairing room auto-readies on join (no manual ready-check) so the
      // match starts the moment BOTH paired players have joined.
      if (this.rooms.tournamentMetaOf(payload.roomId)) this.rooms.setReady(socket.data.userId, true);
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
    // Leaving the room voids any open rematch offer (the roster just broke).
    this.cancelRematch(roomId, 'left');
    const room = this.rooms.getRoom(roomId);
    const seat = this.rooms.seatOf(roomId, socket.data.userId);
    const userId = socket.data.userId;
    const wasPractice = room?.practice ?? false;
    this.clearGhostFill(roomId); // a pending free-lobby auto-fill is moot once someone leaves

    // Detach this socket from the room immediately.
    void socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.seat = null;

    // Wrap the awaited teardown so a throw still ACKs the client (the socket was already
    // detached above) instead of hanging its callback until timeout.
    try {
      if (room && room.status === 'inMatch' && seat >= 0) {
        // Mid-match leave: the match CONTINUES without them (or ends if too few remain).
        // forfeitMatch marks the seat gone in the engine and releases room membership
        // synchronously (before any await), so an instant re-create/join won't hit
        // 'already_in_room', and it broadcasts the lobby itself.
        await this.forfeitMatch(roomId, seat);
      } else {
        this.leaveAndNotify(userId, roomId);
      }
      // Practice rooms are ephemeral: once the human is gone, remove the bots so the
      // room empties + is deleted (otherwise it lingers with only bots seated).
      if (wasPractice) this.teardownPractice(roomId);
      reply({ ok: true });
    } catch (e) {
      console.error('[gateway] onLeave teardown failed:', e);
      reply({ ok: true }); // the socket is already out of the room — report success
    }
  }

  /** A seated player opts into a REMATCH of the just-finished room. When every present
   *  player has opted in within the window, the room resets + a new match deals (same
   *  seats/teams/stake) via the normal beginMatch path (fresh matchId + re-escrow).
   *  Works for cash, practice (bots auto-accept) AND ranked (the room keeps ranked=true,
   *  so the replay is a full ranked match and MMR updates at settle). Only TOURNAMENT
   *  rooms are rejected — those advance their own bracket. */
  private async onRematch(socket: IOSocket, ack: (res: Ack) => void): Promise<void> {
    const reply = safeAck(ack);
    const roomId = socket.data.roomId;
    const userId = socket.data.userId;
    if (!roomId || !userId) return reply(ackError('no_room', 'Nuk je në një dhomë.'));
    const room = this.rooms.getRoom(roomId);
    if (!room || room.status !== 'finished') return reply(ackError('no_room', 'Ndeshja nuk ka mbaruar ende.'));
    if (room.tournament) return reply(ackError('rematch_unavailable', 'Turnet nuk kanë rivanç.'));
    if (!room.seats.some((s) => s.userId === userId)) return reply(ackError('no_seat', 'Nuk ke vend në dhomë.'));
    // The full roster must still be present — a seat freed by someone leaving means we
    // can't reseat the same people (they can open a fresh room instead).
    const rosterPresent = room.seats.every((s) => s.userId !== null && (isBot(s.userId) || s.connected));
    if (!rosterPresent) return reply(ackError('rematch_unavailable', 'Dikush u largua — nuk ka rivanç.'));

    let offer = this.rematchAccepts.get(roomId);
    if (!offer) {
      offer = { users: new Set<string>(), deadline: Date.now() + this.rematchMs };
      // Bots can't opt in → auto-accept their seats so a practice rematch needs only the human.
      for (const s of room.seats) if (s.userId && isBot(s.userId)) offer.users.add(s.userId);
      this.rematchAccepts.set(roomId, offer);
      this.rematchTimers.set(roomId, setTimeout(() => this.cancelRematch(roomId, 'timeout'), this.rematchMs));
    }
    offer.users.add(userId);
    reply({ ok: true });

    const accepted = [...offer.users].filter((id) => !isBot(id));
    this.io.to(roomId).emit('rematch:offer', { roomId, accepted, deadline: offer.deadline });

    // Everyone present opted in? → reset + ready all + start. Escrow runs in beginMatch;
    // a seat that can't cover the stake is unreadied there (same as a normal ready-up).
    const everyone = room.seats.every((s) => !s.userId || offer!.users.has(s.userId));
    if (everyone) {
      this.clearRematch(roomId);
      if (this.rooms.resetForRematch(roomId)) {
        for (const s of room.seats) if (s.userId) this.rooms.setReady(s.userId, true);
        this.broadcastRoomState(roomId);
        this.maybeStartCountdown(roomId); // all ready ⇒ countdown ⇒ beginMatch (escrow + deal)
      }
    }
  }

  /** Cancel an open rematch offer (window lapsed / a player left). The room stays
   *  finished; clients fall back to leaving or re-offering. No-op if no offer is open. */
  private cancelRematch(roomId: string, reason: string): void {
    if (!this.rematchAccepts.has(roomId)) return;
    this.clearRematch(roomId);
    this.io.to(roomId).emit('rematch:cancelled', { roomId, reason });
  }

  /** Drop the offer bookkeeping + its timer (on success, cancel, or room teardown). */
  private clearRematch(roomId: string): void {
    const t = this.rematchTimers.get(roomId);
    if (t) { clearTimeout(t); this.rematchTimers.delete(roomId); }
    this.rematchAccepts.delete(roomId);
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
      // Capture the seat + active game index BEFORE the move is applied (a play
      // can end the game and advance the index) so the move-log groups it right.
      const gameIndex = this.gameIndexOf(socket.data.roomId);
      const res = this.rooms.play(socket.data.userId, payload.cards);
      this.afterAction(res, reply, socket, 'game:play', { gameIndex, type: 'play', cards: payload.cards });
    } catch (e) {
      console.error('[gateway] onPlay failed', e);
      reply(ackError('server_error', 'Gabim i brendshëm.'));
    }
  }
  private onPass(socket: IOSocket, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    try {
      const gameIndex = this.gameIndexOf(socket.data.roomId);
      const res = this.rooms.pass(socket.data.userId);
      this.afterAction(res, reply, socket, 'game:pass', { gameIndex, type: 'pass', cards: null });
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
      const gameIndex = this.gameIndexOf(socket.data.roomId);
      const res = this.rooms.switchGive(socket.data.userId, payload.card);
      this.afterAction(res, reply, socket, 'game:switchGive', { gameIndex, type: 'switch', cards: [payload.card] });
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
    log?: { gameIndex: number; type: MatchActionType; cards: Card[] | null },
  ): void {
    if (!res.ok) {
      // Server-authoritative rejection: log the illegal/impossible move (spec §9).
      console.warn('[anti-cheat] rejected move', { event, userId: socket.data.userId, roomId: socket.data.roomId, reason: res.reason, code: res.code });
      // Forward the specific rejection CODE (client localizes it); 'illegal' is the
      // generic fallback. The Albanian `reason` stays as the message fallback.
      return ack(ackError(res.code ?? 'illegal', res.reason ?? 'Lëvizje e palejuar.'));
    }
    ack({ ok: true });
    this.idleStrikes.delete(socket.data.userId); // a real move resets the AFK counter
    // Record the move-log BEFORE applyResult — applyResult may finalize the match
    // (which drops the per-match seq counter), so the final move must be assigned
    // its seq first. Isolated + fire-and-forget; never affects play.
    if (res.roomId && log) this.recordAction(res.roomId, socket.data.seat ?? -1, log);
    if (res.roomId) this.applyResult(res.roomId, res);
  }

  /** Current active game index of a room's match (0 if not in a match). */
  private gameIndexOf(roomId: string | null): number {
    if (!roomId) return 0;
    const room = this.rooms.getRoom(roomId);
    return room?.match ? room.match.snapshot().gameIndex : 0;
  }

  /**
   * Persist one applied move to the move-log. `seq` is assigned synchronously
   * (monotonic per match) so replay ordering is correct regardless of async write
   * timing; the write itself is fire-and-forget and can never block play.
   */
  private recordAction(roomId: string, seat: number, log: { gameIndex: number; type: MatchActionType; cards: Card[] | null }): void {
    if (!this.matchLog || seat < 0) return;
    const matchId = this.rooms.matchIdOf(roomId);
    if (!matchId) return;
    const seq = this.matchActionSeq.get(matchId) ?? 0;
    this.matchActionSeq.set(matchId, seq + 1);
    void this.matchLog.append({ matchId, seq, gameIndex: log.gameIndex, seat, type: log.type, cards: log.cards, at: Date.now() }).catch(() => undefined);
  }

  // ---------- Spectating -----------------------------------------------------

  /**
   * Watch a live match. The socket joins the room's broadcast channel (so it
   * receives the SAME public, hands-hidden state every player's client sees) but
   * takes no seat — kept on a separate `spectating` field so none of the
   * seated-player logic (leave/abandon/reconnect) ever treats a watcher as a
   * player. Private hands go to personal rooms only, never the room channel.
   */
  private onSpectate(socket: IOSocket, payload: { roomId: string }, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (!payload || !isNonEmptyString(payload.roomId)) return reply(ackError('bad_request', 'Dhomë e pavlefshme.'));
    const roomId = payload.roomId;
    const room = this.rooms.getRoom(roomId);
    if (!room || room.status === 'finished') return reply(ackError('no_room', 'Ndeshja nuk është e disponueshme.'));
    // Spectate IDOR gate (socket-5/6): only PUBLIC lobby tables are watchable. A
    // private (invite/code), ranked-ladder, practice (vs-bot) or tournament-bracket
    // room must never be opened to an arbitrary watcher — that would leak the live
    // table (and, for private rooms, the join flow) to anyone who guesses the room id.
    if (room.private || room.ranked || room.practice || room.tournament) {
      return reply(ackError('no_room', 'Ndeshja nuk është e disponueshme.'));
    }
    // A seated player can't also spectate (would desync their own room view).
    if (socket.data.roomId || this.rooms.seatOf(roomId, socket.data.userId) >= 0) {
      return reply(ackError('seated', 'Po luan — nuk mund të shikosh njëkohësisht.'));
    }
    if (socket.data.spectating && socket.data.spectating !== roomId) this.removeSpectator(socket);
    if (socket.data.spectating !== roomId) {
      const current = this.spectatorCount.get(roomId) ?? 0;
      if (current >= SPECTATOR_CAP) return reply(ackError('spectators_full', 'Kuota e shikuesve është mbushur.'));
      this.spectatorCount.set(roomId, current + 1);
      socket.data.spectating = roomId;
      void socket.join(roomId);
      this.emitSpectatorCount(roomId);
    }
    reply({ ok: true, roomId });
    this.pushSpectatorState(socket, roomId); // catch the watcher up to the live state
  }

  /** Broadcast the room's live spectator count to everyone in it (players + watchers). */
  private emitSpectatorCount(roomId: string): void {
    this.io.to(roomId).emit('room:spectators', { count: this.spectatorCount.get(roomId) ?? 0 });
  }

  private onUnspectate(socket: IOSocket, ack: (res: Ack) => void): void {
    const reply = safeAck(ack); // always allowed (never rate-gated)
    this.removeSpectator(socket);
    reply({ ok: true });
  }

  /** Send a joining spectator the current public state (room + game + scoreboard). */
  private pushSpectatorState(socket: IOSocket, roomId: string): void {
    const roomState = this.roomStateWithCountdown(roomId);
    if (roomState) {
      // Never hand a non-seated watcher the room's private join code (socket-5/6) — a
      // watcher is not a member and must not be able to re-share/rejoin via the code.
      // (Public rooms have no joinCode; this is belt-and-suspenders for any future type.)
      socket.emit('room:state', { ...roomState, joinCode: null });
    }
    const room = this.rooms.getRoom(roomId);
    if (room?.status === 'inMatch') {
      // During the inter-hand pause the next hand is dealt server-side but HELD — don't
      // leak it to a joining spectator (the players are still on the standings screen).
      // Skip the live game state this cycle; the next game:state broadcasts when it deals.
      if (!this.interHandGates.has(roomId)) {
        const pub = this.rooms.publicGameDTO(roomId, this.deadlineFor(roomId));
        if (pub) socket.emit('game:state', pub);
      }
      const sb = this.rooms.scoreboardDTO(roomId);
      if (sb) socket.emit('match:scoreboard', sb);
    }
  }

  /** Detach a socket from whatever room it's watching, freeing its spectator slot. */
  private removeSpectator(socket: IOSocket): void {
    const roomId = socket.data.spectating;
    if (!roomId) return;
    socket.data.spectating = null;
    void socket.leave(roomId);
    const n = (this.spectatorCount.get(roomId) ?? 1) - 1;
    if (n <= 0) this.spectatorCount.delete(roomId);
    else this.spectatorCount.set(roomId, n);
    if (this.rooms.getRoom(roomId)) this.emitSpectatorCount(roomId); // notify remaining watchers/players
  }

  // ---------- Ranked matchmaking ---------------------------------------------

  /** All currently-connected local sockets for a user (single-instance). */
  private socketsOf(userId: string): IOSocket[] {
    const out: IOSocket[] = [];
    for (const s of this.io.sockets.sockets.values()) if (s.data.userId === userId) out.push(s);
    return out;
  }

  /** Push a queue status to one user (matchType=null ⇒ "you've left the queue"). */
  private emitQueueTo(userId: string, matchType: MatchType | null): void {
    this.io.to(personalRoom(userId)).emit('ranked:queue:update', {
      inQueue: matchType !== null,
      matchType,
      size: matchType && this.matchmaking ? this.matchmaking.count(matchType) : 0,
      needed: matchType ? PLAYERS_PER_TYPE[matchType] : 0,
    });
  }

  /** Refresh the live waiting count for everyone still queued for a type. */
  private broadcastQueueCount(type: MatchType): void {
    if (!this.matchmaking) return;
    for (const userId of this.matchmaking.userIdsIn(type)) this.emitQueueTo(userId, type);
  }

  private async onRankedQueueJoin(socket: IOSocket, payload: { matchType: MatchType }, ack: (res: Ack) => void): Promise<void> {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (this.rejectIfDraining(reply)) return;
    if (!this.matchmaking || !this.ranked) return reply(ackError('unavailable', 'Ranked s’është i disponueshëm.'));
    if (!payload || !isMatchType(payload.matchType)) return reply(ackError('bad_request', 'Lloj ndeshjeje i pavlefshëm.'));
    if (socket.data.roomId) return reply(ackError('already_in_room', 'Je tashmë në një dhomë.'));
    const userId = socket.data.userId;
    const standing = await this.ranked.getUserRanked(userId).catch(() => null);
    this.matchmaking.enqueue({ userId, username: socket.data.username, rating: standing?.rating ?? 1000, matchType: payload.matchType, since: Date.now() });
    reply({ ok: true });
    this.tryFormRanked(payload.matchType);     // may seat the joiner + others right away
    this.broadcastQueueCount(payload.matchType); // anyone still waiting gets the new count
  }

  private onRankedQueueLeave(socket: IOSocket, ack: (res: Ack) => void): void {
    const reply = safeAck(ack); // leaving the queue is always allowed (no rate gate)
    this.matchmaking?.remove(socket.data.userId);
    this.emitQueueTo(socket.data.userId, null);
    reply({ ok: true });
  }

  /** Seat every startable group for a match type into fresh ranked rooms. */
  private tryFormRanked(type: MatchType): void {
    if (!this.matchmaking) return;
    for (let group = this.matchmaking.formGroup(type); group; group = this.matchmaking.formGroup(type)) {
      this.seatRankedGroup(group, type);
    }
  }

  /**
   * Create a ranked room and seat a matched group into it, reusing the normal
   * room lifecycle (createRoom/joinRoom → ready → countdown → beginMatch). Queued
   * users are guaranteed connected + roomless (enforced on enqueue + cleared on
   * create/join/disconnect), so seating succeeds; the failure paths are defensive
   * and just release the group back to the lobby.
   */
  private seatRankedGroup(group: QueueEntry[], type: MatchType): void {
    const [creator, ...rest] = group;
    if (!creator || this.rooms.roomOf(creator.userId)) return this.dropGroup(group);
    const created = this.rooms.createRoom({ userId: creator.userId, username: creator.username }, { type, stakeCents: 0, ranked: true });
    if (!created.ok || !created.roomId) return this.dropGroup(group);
    const roomId = created.roomId;
    this.ownership?.claim(roomId);
    for (const e of rest) {
      if (!this.rooms.joinRoom({ userId: e.userId, username: e.username }, roomId).ok) {
        for (const u of group) this.rooms.leaveRoom(u.userId); // tear the half-built room down
        return this.dropGroup(group);
      }
    }
    for (const e of group) {
      for (const s of this.socketsOf(e.userId)) {
        s.data.roomId = roomId;
        s.data.seat = this.rooms.seatOf(roomId, e.userId);
        void s.join(roomId);
      }
      this.rooms.setReady(e.userId, true);
      this.emitQueueTo(e.userId, null); // out of the queue — into a match
    }
    this.broadcastRoomState(roomId);
    this.maybeStartCountdown(roomId); // all ready ⇒ commit + countdown + deal
    this.broadcastLobby();
  }

  /** Reset clients' queue UI when a (rare) seating failure drops a group. */
  private dropGroup(group: QueueEntry[]): void {
    for (const e of group) this.emitQueueTo(e.userId, null);
  }

  // ---------- Practice vs bots -----------------------------------------------

  /**
   * Spin up a private ZERO-STAKE room, seat the requester, and fill the remaining
   * seats with AI bots, then start. Bots are socket-less synthetic players that
   * act server-side on their turn (see driveBot). Because the stake is 0 there is
   * no escrow/settlement, so bots never touch money. Practice rooms are hidden
   * from the lobby + spectators and are NOT rated / do NOT award XP.
   */
  private onPracticeStart(socket: IOSocket, payload: { type: MatchType; tier?: BotTier } | undefined, ack: (res: Ack) => void): void {
    const reply = safeAck(ack);
    if (!this.rateOk(socket, reply)) return;
    if (this.rejectIfDraining(reply)) return;
    const userId = socket.data.userId;
    if (this.rooms.roomOf(userId)) return reply(ackError('already_in_room', 'Je tashmë në një dhomë.'));
    const type = payload?.type;
    if (type !== '1v1' && type !== '1v1v1' && type !== '2v2') return reply(ackError('bad_type', 'Lloji i ndeshjes është i pavlefshëm.'));
    // Default to the strongest brain (search-based 'hard') so opponents actually play
    // well — hoard high cards, shed efficiently, count, and pass when right. Easy/medium
    // remain selectable for a gentler game.
    const tier: BotTier = payload?.tier === 'easy' || payload?.tier === 'medium' ? payload.tier : 'hard';

    const created = this.rooms.createRoom({ userId, username: socket.data.username, avatar: socket.data.avatar }, { type, stakeCents: 0, practice: true });
    if (!created.ok || !created.roomId) return reply(ackError('create_failed', created.error?.message ?? 'Nuk u krijua dot.'));
    const roomId = created.roomId;
    this.ownership?.claim(roomId);
    this.botTiers.set(roomId, tier);

    for (const s of this.socketsOf(userId)) {
      s.data.roomId = roomId;
      s.data.seat = this.rooms.seatOf(roomId, userId);
      void s.join(roomId);
    }
    this.rooms.setReady(userId, true);

    if (!this.fillEmptySeatsWithBots(roomId, socket.data.username)) {
      this.teardownPractice(roomId);
      return reply(ackError('seat_failed', 'Vendet nuk u mbushën.'));
    }
    reply({ ok: true, roomId });
    this.broadcastRoomState(roomId);
    this.maybeStartCountdown(roomId); // all ready ⇒ commit + countdown + deal
  }

  /**
   * Seat a fill-player ("ghost") in every empty seat of a ZERO-STAKE room, ready +
   * connected so the match can start. Human-like names (the client only sees the
   * username). HARD GUARD: refuses outright on any staked room — fill players must
   * NEVER enter a real-money game (that would be fraud); escrow is gated on stake>0
   * too, so this is belt-and-suspenders. Returns false if seating failed.
   */
  private fillEmptySeatsWithBots(roomId: string, humanName?: string | null): boolean {
    const room = this.rooms.getRoom(roomId);
    if (!room) return false;
    if (room.stakeCents !== 0) return false; // ⛔ never fill a staked/real-money room
    const empties = room.seats.map((s, i) => (s.userId ? -1 : i)).filter((i) => i >= 0);
    const names = pickGhostNames(empties.length, humanName);
    for (let k = 0; k < empties.length; k += 1) {
      const seat = empties[k]!;
      const botId = `${BOT_PREFIX}${roomId}:${seat}`;
      const joined = this.rooms.joinRoom({ userId: botId, username: names[k] ?? `Lojtar ${seat + 1}` }, roomId);
      if (!joined.ok) return false;
      this.rooms.setConnected(botId, true);
      this.rooms.setReady(botId, true);
    }
    return true;
  }

  /** Schedule a bot's move after a short, natural "thinking" delay. */
  private scheduleBot(roomId: string, seat: number): void {
    const prev = this.botTimers.get(roomId);
    if (prev) clearTimeout(prev);
    const delay = this.botDelayMs ?? (BOT_MIN_DELAY + Math.floor(Math.random() * (BOT_MAX_DELAY - BOT_MIN_DELAY)));
    this.botTimers.set(roomId, setTimeout(() => { this.botTimers.delete(roomId); this.driveBot(roomId, seat); }, delay));
  }

  /** Compute + apply a bot's move for its current turn (or card-switch return). */
  private driveBot(roomId: string, seat: number): void {
    const room = this.rooms.getRoom(roomId);
    if (!room?.match || room.status !== 'inMatch') return;
    const botUserId = this.userAtSeat(roomId, seat);
    if (!isBot(botUserId)) return;
    const tier = this.botTiers.get(roomId) ?? 'hard';
    const snap = room.match.snapshot();

    // Card-switch: the bot is the winner who must return a 3–10 card. Return the
    // weakest eligible (same choice the auto-resolver makes for an idle human).
    if (snap.pendingSwitch && snap.pendingSwitch.winner === seat) {
      const eligible = room.match.eligibleReturnCardsForWinner();
      if (eligible.length === 0) return; // engine skips the return; armTurnTimer re-runs
      const weakest = [...eligible].sort((a, b) => singlePower(a) - singlePower(b))[0]!;
      const res = this.rooms.switchGive(botUserId, weakest);
      if (res.ok && res.roomId) this.applyBotResult(res.roomId, seat, snap.gameIndex, 'switch', [weakest], res);
      return;
    }

    const pub = this.rooms.publicGameDTO(roomId, null);
    const hand = this.rooms.handOf(roomId, seat);
    if (!pub || pub.turn !== seat || !hand) return; // no longer the bot's turn
    // First-game opener: the engine requires the opening lead to include a SPECIFIC
    // card — the lowest start-suit (♠) card actually dealt: the 3♠, or 4♠/5♠/… when
    // the 3♠ wasn't dealt. Use the engine's real opening card (snapshot.game.openingCard,
    // which is null once the game has opened), NOT a hardcoded 3♠ — otherwise, when the
    // bot is the opener with a higher ♠, it leads illegally, the play is rejected, it
    // can't pass an opening lead, and the match freezes on the bot's turn.
    const opening = snap.game?.openingCard ?? null;
    const mustInclude = opening && opening.kind === 'standard' && pub.pile == null
      ? hand.find((c) => c.kind === 'standard' && c.rank === opening.rank && c.suit === opening.suit)
      : undefined;
    const move = decideBotMove(
      {
        hand: [...hand], pile: pub.pile, canPass: pub.pile != null,
        opponentCounts: pub.handCounts.filter((_, i) => i !== seat), mustInclude,
        seen: this.seenCards.get(roomId) ?? [],
        // Full public state so the Hard tier can run its look-ahead search.
        mySeat: seat,
        numPlayers: pub.handCounts.length,
        pileOwner: pub.pileOwner,
        passed: pub.passed,
        active: pub.active,
        handCounts: pub.handCounts,
        finishingOrder: pub.finishingOrder,
      },
      tier,
    );
    const res = move.action === 'play' ? this.rooms.play(botUserId, move.cards) : this.rooms.pass(botUserId);
    if (!res.ok) {
      // decideBotMove only yields legal moves; this is a defensive recovery so a
      // rejected bot move can never stall the match.
      console.warn('[bot] move rejected, recovering', { roomId, seat, reason: res.reason });
      const fb = this.rooms.pass(botUserId);
      if (fb.ok && fb.roomId) this.applyBotResult(fb.roomId, seat, snap.gameIndex, 'pass', null, fb);
      return;
    }
    this.applyBotResult(res.roomId ?? roomId, seat, snap.gameIndex, move.action === 'play' ? 'play' : 'pass', move.action === 'play' ? move.cards : null, res);
  }

  private applyBotResult(roomId: string, seat: number, gameIndex: number, type: MatchActionType, cards: Card[] | null, res: MatchActionResult & { roomId?: string }): void {
    this.recordAction(roomId, seat, { gameIndex, type, cards });
    this.applyResult(roomId, res);
  }

  private clearBotTimer(roomId: string): void {
    const t = this.botTimers.get(roomId);
    if (t) { clearTimeout(t); this.botTimers.delete(roomId); }
  }

  /** Arm an auto-fill for a FREE (zero-stake) waiting room: if no humans join within
   *  GHOST_FILL_MS, seat fill-players and start, so the host never sits alone. Humans
   *  get priority (joining cancels it). HARD-GATED to zero-stake, non-ranked, public,
   *  non-practice rooms — a staked/real-money room is NEVER auto-filled. */
  private armGhostFill(roomId: string): void {
    const room = this.rooms.getRoom(roomId);
    if (!room || room.stakeCents !== 0 || room.ranked || room.practice || room.private) return; // ⛔ only free public lobbies
    if (room.status !== 'waiting') return;
    const humans = room.seats.filter((s) => s.userId && !isBot(s.userId)).length;
    const empties = room.seats.filter((s) => !s.userId).length;
    if (humans < 1 || empties < 1) return; // need a host + room to fill
    if (this.ghostFillTimers.has(roomId)) return; // already armed
    this.ghostFillTimers.set(roomId, setTimeout(() => {
      this.ghostFillTimers.delete(roomId);
      const r = this.rooms.getRoom(roomId);
      // Re-check EVERYTHING at fire time — humans may have joined/filled/started meanwhile.
      if (!r || r.stakeCents !== 0 || r.ranked || r.private || r.practice || r.status !== 'waiting') return;
      const human = r.seats.filter((s) => s.userId && !isBot(s.userId));
      // Only auto-fill a SOLO host ("when there are no other players"). If others joined,
      // leave it to the humans; if the host left, do nothing.
      if (human.length !== 1) return;
      if (!r.seats.some((s) => !s.userId)) return; // already full
      const host = human[0];
      this.rooms.markPractice(roomId); // no XP/ranked/stats/money vs fill-players (also stake is 0)
      this.botTiers.set(roomId, 'hard'); // free-table ghosts play with the strong (search) brain
      if (!this.fillEmptySeatsWithBots(roomId, host?.username ?? null)) { this.teardownPractice(roomId); return; }
      this.broadcastRoomState(roomId);
      this.maybeStartCountdown(roomId);
    }, this.ghostFillMs));
  }

  private clearGhostFill(roomId: string): void {
    const t = this.ghostFillTimers.get(roomId);
    if (t) { clearTimeout(t); this.ghostFillTimers.delete(roomId); }
  }

  /** Remove a practice room's bots + timers (called when the human leaves/disconnects). */
  private teardownPractice(roomId: string): void {
    this.clearGhostFill(roomId);
    this.clearBotTimer(roomId);
    this.botTiers.delete(roomId);
    this.seenCards.delete(roomId);
    this.ownership?.release(roomId);
    const room = this.rooms.getRoom(roomId);
    if (room) for (const s of room.seats) if (isBot(s.userId)) this.rooms.leaveRoom(s.userId!);
  }

  // ---------- Ready-check countdown ------------------------------------------

  private maybeStartCountdown(roomId: string): void {
    if (!this.rooms.allReady(roomId)) {
      this.clearCountdown(roomId);
      return;
    }
    if (this.timers.hasCountdown(roomId)) return; // already counting down
    this.clearGhostFill(roomId); // the room is starting → cancel any pending free-lobby auto-fill
    // A tournament pairing is starting (both joined) → cancel its no-show walkover.
    const noShow = this.tournamentNoShowTimers.get(roomId);
    if (noShow) { clearTimeout(noShow); this.tournamentNoShowTimers.delete(roomId); }

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

    this.timers.armCountdown(roomId, this.countdownMs, () => void this.beginMatch(roomId));
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

    // Real-money gates for a staked match: every player must clear the enabled
    // compliance checks (KYC/age/geo/self-exclusion) AND their own responsible-
    // gaming daily loss cap before any money moves. A failure unreadies that
    // player + tells them why; if anyone is blocked the match doesn't start.
    if (room.stakeCents > 0) {
      let blocked = false;
      const fail = (userId: string, code: string | undefined, message: string | undefined) => {
        blocked = true;
        this.rooms.setReady(userId, false);
        this.io.to(personalRoom(userId)).emit('error', { code: code ?? 'blocked', message: message ?? 'Bllokuar nga rregullat.' });
      };
      for (const s of room.seats) {
        if (!s.userId) continue;
        // Account-state gate (always on, no deployment switch): a frozen account
        // cannot stake. Banned/suspended can't be logged in, so 'frozen' is the
        // case that bites here.
        const acct = await this.auth.checkAccountRealMoney(s.userId);
        if (!acct.allowed) { fail(s.userId, acct.code, acct.message); continue; }
        if (this.compliance?.enabled) {
          const profile = await this.auth.getComplianceProfile(s.userId);
          const verdict = profile ? this.compliance.checkRealMoney(profile) : { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
          if (!verdict.allowed) { fail(s.userId, verdict.code, verdict.message); continue; }
        }
        // Responsible-gaming daily loss cap. The check is read-then-escrow (not
        // atomic), but it can't be raced into a bypass HERE: a user is in at most
        // one room (RoomManager rejects already_in_room), so they have exactly one
        // check→escrow sequence at a time; and a prior match's fire-and-forget
        // settlement only ever makes this MORE restrictive (the bet/loss is already
        // escrowed; a pending payout would reduce the loss), i.e. fail-safe. Making
        // it atomic inside escrow() is the right move once matches can run
        // multi-instance — a documented follow-up.
        if (this.rg) {
          const loss = await this.rg.checkLoss(s.userId);
          if (!loss.allowed) fail(s.userId, loss.code, loss.message);
        }
      }
      if (blocked) {
        this.broadcastRoomState(roomId);
        return;
      }
    }

    // Practice (zero-stake vs BOTS) never touches money: bots aren't real users, so
    // persisting a match row + match_players would violate the users FK on Postgres
    // (this is why practice failed to start on the live DB but worked in-memory).
    let escrowed = false;
    if (this.money && !room.practice) {
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
          // Practice (vs bots) never creates a `matches` row (no escrow), and the
          // games table FKs matchId → matches, so persisting practice seeds would
          // always FK-violate. Practice is unrated + unverifiable anyway, so skip it.
          if (this.games && !room.practice) {
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
    this.timers.clearCountdown(roomId);
    this.pendingServerSeeds.delete(roomId); // abandon the committed-but-unused seed
  }

  /** Room DTO with the live ready-check countdown (ms remaining) overlaid. */
  private roomStateWithCountdown(roomId: string): ReturnType<RoomManager['roomStateDTO']> {
    const state = this.rooms.roomStateDTO(roomId);
    if (!state) return state;
    const deadline = this.timers.countdownDeadline(roomId);
    state.countdownMs = deadline !== null ? Math.max(0, deadline - Date.now()) : null;
    // Redact fill-player (bot) userIds from the client DTO: their userId carries the
    // 'bot:' prefix, which would unmask them in the WebSocket frame. The client never
    // needs a bot's id (only its own + real opponents'), so null it out — keeping the
    // human-like username only. (Defense for the "ghost" disguise on free tables.)
    for (const s of state.seats) if (isBot(s.userId)) s.userId = null;
    return state;
  }

  // ---------- Result -> emissions --------------------------------------------

  private applyResult(roomId: string, res: MatchActionResult): void {
    // Card memory for practice bots: remember every committed play this game so the
    // Hard tier can count what's still out. Only tracked for practice (the only
    // rooms with bots) to keep real-money games' hot path untouched.
    const trackSeen = this.rooms.getRoom(roomId)?.practice ?? false;
    for (const ev of res.gameEvents) {
      if (ev.kind === 'played') {
        if (trackSeen) {
          const arr = this.seenCards.get(roomId) ?? [];
          arr.push(...ev.combo.cards);
          this.seenCards.set(roomId, arr);
        }
      } else if (ev.kind === 'trickWon') this.io.to(roomId).emit('game:trickWon', { winner: ev.winner, leadsNext: ev.leadsNext });
      else if (ev.kind === 'playerFinished') this.io.to(roomId).emit('game:playerFinished', { seat: ev.seat, place: ev.place });
    }

    // A hand just ended ⇒ hold the next hand on the standings screen and DEFER every
    // new-hand reveal (the loser↔winner card switch AND the fresh deal) until everyone
    // taps Continue (or the pause times out). This is what guarantees new cards never
    // appear before Continue. The pause is armed on the hand-end (gameScored), so it also
    // covers the common "winner returns a 3–10" switch, whose game:start arrives later.
    const handEnded = res.matchEvents.some((e) => e.kind === 'gameScored');
    const matchEnded = res.matchEvents.some((e) => e.kind === 'matchEnded');
    const nextGameIndex = this.rooms.getRoom(roomId)?.match?.snapshot().gameIndex ?? 0;
    const gating = handEnded && !matchEnded && this.handPauseMs > 0 && nextGameIndex > 0;

    let gatedNextHand = false; // a hand just ended → the next deal is paused (see below)
    const deferred: Array<() => void> = []; // new-hand reveals, replayed on Continue
    let dealsNextHand = false; // a gameStarted arrived → deal it when the pause releases
    // Run a reveal now, or queue it for after Continue while the standings pause is active.
    const reveal = (fn: () => void) => { if (gating) deferred.push(fn); else fn(); };

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
        case 'cardSwitchAuto': {
          // Loser's strongest card was just moved to the winner: refresh BOTH private
          // hands so neither board is stale. Deferred while gating so the new cards stay
          // hidden behind the standings screen.
          const e = ev;
          reveal(() => {
            this.pushHand(roomId, e.loser);
            this.pushHand(roomId, e.winner);
            this.emitCardSwitch(roomId, { winner: e.winner, loser: e.loser, given: e.card, returned: null, awaitingReturn: true });
          });
          break;
        }
        case 'awaitingSwitch': {
          // The winner must choose a 3–10 card to return — prompt them privately (after
          // Continue when gating, so the prompt and their fresh hand appear together).
          const e = ev;
          reveal(() => {
            const winnerU = this.userAtSeat(roomId, e.winner);
            if (winnerU) {
              this.io.to(personalRoom(winnerU)).emit('card:switch', {
                winner: e.winner, loser: e.loser, given: null, returned: null, awaitingReturn: true,
              });
            }
          });
          break;
        }
        case 'cardSwitchReturn': {
          const e = ev;
          reveal(() => this.emitCardSwitch(roomId, { winner: e.winner, loser: e.loser, given: null, returned: e.card, awaitingReturn: false }));
          break;
        }
        case 'noSwap': {
          // Loser holds both jokers → no switch this game; the winner leads. Tell clients
          // so they can show the "no swap" banner.
          const e = ev;
          reveal(() => this.io.to(roomId).emit('match:noSwap', { winner: e.winner, loser: e.loser }));
          break;
        }
        case 'gameStarted':
          // The next hand is ready. While gating, hold it behind Continue (released
          // below). Otherwise (first hand, or the switch-return step) deal immediately.
          if (gating) dealsNextHand = true;
          else this.startNewGameBroadcast(roomId);
          break;
        case 'matchEnded':
          // Settle the pot (pay winners, book rake), then emit the result.
          void this.settleAndEmitMatchEnd(roomId, ev.winnerSide, ev.winnerSeats, ev.finalSideScores);
          break;
      }
    }

    if (gating) {
      // Hold on the standings screen; on release replay the deferred reveals, then either
      // deal the next hand (game:start) or — if the winner still owes a switch-return —
      // refresh the board + arm the return timeout so the match can never hang.
      gatedNextHand = true;
      this.armInterHandGate(roomId, () => {
        for (const fn of deferred) fn();
        if (dealsNextHand) this.startNewGameBroadcast(roomId);
        else { this.broadcastPublicState(roomId); this.armTurnTimer(roomId); }
      });
    }

    // Refresh public state and (re)arm the turn timer, unless the match ended — or the
    // next hand is paused on the standings screen (gatedNextHand): in that window there's
    // no active turn yet, and the next hand's state must NOT be revealed until it deals,
    // so skip both here (startNewGameBroadcast does them when the pause releases).
    const room = this.rooms.getRoom(roomId);
    if (room && room.status === 'inMatch') {
      if (!gatedNextHand) {
        this.broadcastPublicState(roomId);
        this.armTurnTimer(roomId);
      }
    } else {
      // Match ended normally: stop the turn timer and any pending forfeit timers
      // (a player who disconnected mid-match no longer abandons a finished match).
      this.clearTurnTimer(roomId);
      this.clearInterHandTimer(roomId); // cancel any pending inter-hand pause
      this.clearRoomAbandonTimers(roomId);
      this.clearBotTimer(roomId); // no stray bot move after the match ends
      this.broadcastLobby();
    }
    this.broadcastRoomState(roomId);
  }

  /** Deal-time broadcast: each player gets their own hand; everyone gets counts. */
  private startNewGameBroadcast(roomId: string): void {
    const room = this.rooms.getRoom(roomId);
    // Fresh deal ⇒ no cards seen yet this game (resets the bot's card memory).
    if (room?.practice) this.seenCards.set(roomId, []);
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

  // ---------- Inter-hand pause (standings screen) ----------------------------

  /** Arm the inter-hand standings pause for a room. Holds until every connected human
   *  taps Continue (or handPauseMs elapses), then runs `onRelease` EXACTLY once. The
   *  caller decides what release does (replay the deferred reveals, then deal). */
  private armInterHandGate(roomId: string, onRelease: () => void): void {
    this.clearInterHandTimer(roomId); // never stack two gates on one room
    const release = () => {
      // EXACTLY-ONCE: the timer and the all-continue path can both fire (e.g. the timer
      // callback was already queued when the last Continue arrives) → without this guard
      // the next hand would be dealt twice. The gate's presence IS the guard:
      // clearInterHandTimer deletes it, so a second release() no-ops here.
      if (!this.interHandGates.has(roomId)) return;
      this.clearInterHandTimer(roomId);
      // The room may have ended/abandoned during the pause — only proceed if still in-match.
      const r = this.rooms.getRoom(roomId);
      if (r && r.status === 'inMatch' && r.match) onRelease();
    };
    const timer = setTimeout(release, this.handPauseMs);
    timer.unref?.();
    this.interHandGates.set(roomId, { timer, ready: new Set(), release });
    this.emitContinueState(roomId); // initial 0/N
  }

  /** A player tapped "Continue" on the standings screen. Deal early once EVERY connected
   *  human has done so; otherwise record it + broadcast progress and let the timer run. */
  private onHandContinue(socket: IOSocket): void {
    if (!this.limiter.allow(socket.data.userId)) return;
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const gate = this.interHandGates.get(roomId);
    if (!gate) return; // no inter-hand pause active (already dealt / not between hands)
    const seat = this.rooms.seatOf(roomId, socket.data.userId);
    if (seat < 0) return;
    if (gate.ready.has(seat)) return; // idempotent: a double-tap / re-emit changes nothing
    gate.ready.add(seat);
    this.emitContinueState(roomId);
    if (this.allHumansReady(roomId, gate.ready)) gate.release();
  }

  /** True when every connected, non-bot seat has tapped Continue (or there are none). */
  private allHumansReady(roomId: string, ready: Set<number>): boolean {
    const room = this.rooms.getRoom(roomId);
    if (!room) return true;
    const humans = room.seats
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s.userId != null && !isBot(s.userId) && s.connected);
    if (humans.length === 0) return true; // all bots / nobody connected → let it release
    return humans.every(({ i }) => ready.has(i));
  }

  /** Push the "X/N ready" progress to the room's standings screens. */
  private emitContinueState(roomId: string): void {
    const gate = this.interHandGates.get(roomId);
    const room = this.rooms.getRoom(roomId);
    if (!gate || !room) return;
    const humans = room.seats.filter((s) => s.userId != null && !isBot(s.userId) && s.connected).length;
    this.io.to(roomId).emit('hand:continueState', { ready: [...gate.ready], humans });
  }

  /** Cancel any pending inter-hand pause (room ended / abandoned / torn down). */
  private clearInterHandTimer(roomId: string): void {
    const g = this.interHandGates.get(roomId);
    if (g) { clearTimeout(g.timer); this.interHandGates.delete(roomId); }
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
   * A club member invites an online friend to their club. No invite-state table —
   * the friend joins via the normal join/joinByCode paths. The private joinCode is
   * emitted ONLY for a private club (the member-only secret, fine to hand to a friend
   * the member chose); public clubs are open so no code is needed. Gated by
   * caller-in-club + areFriends — a non-friend can never receive a private code.
   */
  private async onClubInvite(socket: IOSocket, payload: { friendUserId: string }, ack: (res: Ack) => void): Promise<void> {
    const userId = socket.data.userId;
    if (!this.limiter.allow(userId)) return ack(ackError('rate', 'Shumë veprime — prit pak.'));
    if (!this.clubs) return ack(ackError('disabled', 'Klubet s’janë aktive.'));
    const friendId = payload?.friendUserId;
    if (typeof friendId !== 'string' || !friendId) return ack(ackError('bad_request', 'Mik i pavlefshëm.'));
    const club = await this.clubs.getMyClub(userId);
    if (!club) return ack(ackError('no_club', 'Nuk je në një klub.'));
    if (this.friends && !(await this.friends.areFriends(userId, friendId))) {
      return ack(ackError('not_friends', 'Mund të ftosh vetëm miqtë.'));
    }
    this.io.to(personalRoom(friendId)).emit('club:invited', {
      clubId: club.id,
      clubName: club.name,
      tag: club.tag,
      // Hand the code ONLY for a private club (member-only secret); public clubs are open.
      joinCode: club.private ? (club.joinCode ?? null) : null,
      fromUsername: socket.data.username,
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
    if (!room || room.practice) return; // practice vs bots awards no XP/stats (no farming)
    const winSet = new Set(winnerSeats);
    const potCents = room.stakeCents * room.seats.filter((s) => s.userId).length;
    const seats = room.seats
      .map((s, i) => ({ userId: s.userId, i }))
      .filter((x): x is { userId: string; i: number } => x.userId !== null)
      .map((x) => ({ userId: x.userId, won: winSet.has(x.i), potCents }));
    // Push live-refresh signals AFTER the stats write commits (so a reload reads the
    // fresh totals, not a stale snapshot). Best-effort + isolated — a notify failure
    // never affects settlement/scoring. Practice rooms returned early above, so this
    // only fires for real (XP-earning) matches.
    void this.profiles.recordMatch(seats)
      .then(() => this.notifyStatsChanged(seats.map((s) => s.userId)))
      .catch(() => undefined);
  }

  /**
   * A finished match updated player stats. Push two live-refresh signals (no
   * payload — the client refetches): each seated HUMAN reloads their Challenges/
   * Rewards page (XP/wins/streak changed), and everyone watching the leaderboard
   * reloads it (ranks may have moved). Bots are skipped (no socket). Wrapped so a
   * socket error can never escape into the settlement path.
   */
  private notifyStatsChanged(userIds: string[]): void {
    try {
      for (const userId of userIds) {
        if (isBot(userId)) continue;
        this.io.to(personalRoom(userId)).emit('reward:refresh');
      }
      this.io.to(LEADERBOARD_ROOM).emit('leaderboard:refresh');
    } catch {
      // never throws into the fire-and-forget stats path
    }
  }

  /**
   * Update the ranked/season MMR ladder for a finished match. Like cosmetic XP
   * this is isolated and fire-and-forget — a rating-write failure can NEVER
   * affect settlement, scoring, or the rules engine, and it runs OUTSIDE the
   * money transaction. A no-winner (voided/refunded) match is not rated; ranked
   * is a no-op unless an admin has opened a season. Forfeits ARE rated (the
   * quitter loses MMR, the present player gains) to discourage rage-quits.
   */
  private async recordRankedResult(roomId: string, winnerSeats: number[]): Promise<RankedDeltaDTO[]> {
    if (!this.ranked || winnerSeats.length === 0) return [];
    const room = this.rooms.getRoom(roomId);
    if (!room || room.practice) return []; // practice vs bots is never rated
    const winSet = new Set(winnerSeats);
    const seats = room.seats
      .map((s, i) => ({ userId: s.userId, i }))
      .filter((x): x is { userId: string; i: number } => x.userId !== null)
      .map((x) => ({ userId: x.userId, won: winSet.has(x.i) }));
    if (seats.length < 2) return [];
    // Isolated + fail-safe: a rating-write failure resolves to [] so match:end
    // still fires unchanged (settlement already committed before this runs).
    try {
      return await this.ranked.recordMatchResult(seats);
    } catch {
      return [];
    }
  }

  /**
   * Run anti-collusion/anti-bot heuristics over the finished match + record any
   * flags for MANUAL admin review. Isolated + fire-and-forget — never auto-acts,
   * never affects settlement/scoring/rules. (Best-effort: reads the persisted
   * move-log, which on Postgres is written fire-and-forget, so the very last move
   * or two may not be analyzed — acceptable for a heuristic.)
   */
  private recordAntiCheat(roomId: string, winnerSeats: number[] = []): void {
    if (!this.antiCheat) return;
    const matchId = this.rooms.matchIdOf(roomId);
    const room = this.rooms.getRoom(roomId);
    if (!matchId || !room || room.practice) return; // practice vs bots isn't analyzed
    const winSet = new Set(winnerSeats);
    const seats = room.seats
      .map((s, i) => ({ seat: i, userId: s.userId, won: winSet.has(i), team: s.team }))
      .filter((x): x is { seat: number; userId: string; won: boolean; team: 0 | 1 | null } => x.userId !== null);
    if (seats.length < 2) return;
    // Pass the staked flag so collusion analysis (cross-match) runs for money tables only.
    void this.antiCheat.analyzeMatch(matchId, seats, { staked: room.stakeCents > 0 }).catch(() => undefined);
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
    // Hard cap: the per-room delete (tryBeginMatch) frees reused rooms, but a room that
    // finishes and is never reused would linger forever. Evict the oldest once over the
    // cap (Set preserves insertion order) so the set can't grow unbounded → OOM.
    if (this.finalizedMatches.size > 10_000) {
      const oldest = this.finalizedMatches.values().next().value;
      if (oldest !== undefined) this.finalizedMatches.delete(oldest);
    }
    this.matchActionSeq.delete(key); // match over — drop its move-log seq counter
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
    const matchId = this.rooms.matchIdOf(roomId);

    // No winner — EVERY player abandoned (an all-gone forfeit). Void + refund all
    // stakes (no payout, no rake, no XP/MMR), then end cleanly. Defensive: normally
    // a forfeit always leaves a survivor, but this guards the empty-winnerSeats path
    // against a division-by-zero in settle().
    if (winnerSeats.length === 0) {
      if (this.money && matchId) {
        try {
          await this.money.refund(matchId);
        } catch (err) {
          settlementFailures.inc();
          // eslint-disable-next-line no-console
          console.error(`[settlement] all-gone REFUND FAILED for match ${matchId} (room ${roomId}) — recovery sweep will refund:`, err);
          this.io.to(roomId).emit('error', { code: 'settlement_delayed', message: 'Shlyerja u vonua — fondet kthehen automatikisht. Na vjen keq.' });
          this.clearBotTimer(roomId);
          this.rooms.clearGoneSeats(roomId);
          this.broadcastLobby();
          return;
        }
      }
      this.clearRoomStrikes(roomId);
      const sbV = this.rooms.scoreboardDTO(roomId);
      this.io.to(roomId).emit('match:end', {
        winnerSide: -1, winnerSeats: [], finalSideScores,
        scoreboard: sbV ?? { type: this.rooms.getRoom(roomId)?.type ?? '1v1', target: 0, cumulative: [], teamTotals: null },
        payoutCents: null,
      });
      this.revealFair(roomId);
      this.rooms.clearGoneSeats(roomId);
      this.broadcastLobby();
      return;
    }

    let payoutCents: number | null = null;
    if (this.money && matchId) {
      try {
        const endTimer = settlementDuration.startTimer();
        const settlement = await this.money.settle({ matchId, winnerSeats });
        endTimer();
        if (settlement) payoutCents = settlement.payouts.reduce((a, p) => a + p.amountCents, 0);
      } catch (err) {
        // Settlement threw AFTER finalize: the escrowed pot is unpaid. Surface it
        // LOUDLY (counter to PAGE on) and bail BEFORE emitting a normal match:end —
        // the match row stays 'active', so the periodic crash-recovery sweep refunds
        // every stake. Players are told it's delayed, not lost; this never throws on.
        settlementFailures.inc();
        // eslint-disable-next-line no-console
        console.error(`[settlement] FAILED for match ${matchId} (room ${roomId}) — recovery sweep will refund:`, err);
        this.io.to(roomId).emit('error', { code: 'settlement_delayed', message: 'Shlyerja u vonua — fondet kthehen automatikisht. Na vjen keq.' });
        this.clearBotTimer(roomId);
        this.rooms.clearGoneSeats(roomId); // match is 'finished' — free abandoned seats (no in-memory leak)
        this.broadcastLobby();
        return;
      }
    }
    // Capture the tournament pairing (if any) + its winner userId BEFORE clearGoneSeats
    // nulls a forfeited seat — so we can advance the bracket below.
    const tourn = this.rooms.tournamentMetaOf(roomId);
    const tournWinner = tourn
      ? (winnerSeats.length > 0 ? this.userAtSeat(roomId, winnerSeats[0]!) || tourn.players[0] : tourn.players[0])
      : null;

    this.recordMatchStats(roomId, winnerSeats); // cosmetic XP/stats (isolated)
    // Tournament matches never touch the ranked MMR ladder (they're their own bracket).
    const ratingDeltas = tourn ? [] : await this.recordRankedResult(roomId, winnerSeats);
    this.recordAntiCheat(roomId, winnerSeats); // heuristic flags for review (isolated)
    this.clearRoomStrikes(roomId);
    const sb = this.rooms.scoreboardDTO(roomId);
    if (!sb) return;
    this.io.to(roomId).emit('match:end', {
      winnerSide, winnerSeats, finalSideScores, scoreboard: sb, payoutCents,
      ...(ratingDeltas.length ? { ratingDeltas } : {}),
    });
    this.revealFair(roomId);
    this.rooms.clearGoneSeats(roomId); // free any abandoned seats so a rematch starts clean

    // Self-running tournament: this pairing is decided → advance the bracket (build the
    // next round's rooms, or finish + pay the champion). Isolated from settlement above.
    if (tourn && tournWinner) {
      void this.advanceTournament(tourn.tournamentId, tourn.round, tourn.index, tournWinner);
    }
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
    this.timers.armAbandon(userId, this.abandonMs, () => void this.onAbandon(roomId, userId));
  }

  private clearAbandonTimer(userId: string): void {
    this.timers.clearAbandon(userId);
  }

  /** Grace expired and the player is still gone: forfeit the match. */
  private async onAbandon(roomId: string, userId: string): Promise<void> {
    this.timers.clearAbandon(userId);
    if (this.socketCountFor(userId) > 0) return; // reconnected in time
    const seat = this.rooms.seatOf(roomId, userId);
    if (seat < 0) return;
    await this.forfeitMatch(roomId, seat);
  }

  /**
   * A seated player (`abandonerSeat`) left / disconnected past grace / idled out.
   * The match CONTINUES without them — they're auto-passed and placed last every
   * game, forfeiting their stake — UNLESS too few players remain (1v1/1v1v1 down to
   * one, or a whole 2v2 team gone): then the engine emits a terminal `matchEnded`
   * that applyResult settles (pays the survivor side, minus rake) or, if everyone
   * left, voids + refunds. The quitter is excluded from the winners, so they can
   * never be paid. Idempotent: a no-op once the seat is already gone / match over.
   */
  private async forfeitMatch(roomId: string, abandonerSeat: number, reason: 'left' | 'idle' = 'left'): Promise<void> {
    const room = this.rooms.getRoom(roomId);
    if (!room || !room.match || room.status !== 'inMatch') return;
    const userId = this.userAtSeat(roomId, abandonerSeat);
    if (!userId) return;
    const username = room.seats[abandonerSeat]?.username ?? null;

    // The abandoner is out: stop their re-engagement / abandon timer + idle strikes.
    this.clearAbandonTimer(userId);
    this.idleStrikes.delete(userId);
    // If an inter-hand standings pause is active, RELEASE it first so the held next
    // hand actually deals (its game:start + deferred reveals live only in the gate's
    // closure). Clearing it instead would orphan that deal and freeze the survivors
    // on the standings screen — the forfeit then applies to the live next hand.
    const gate = this.interHandGates.get(roomId);
    if (gate) gate.release();

    // Mark the seat gone in the engine + free them from the room (keeping the seat
    // for display/stats/pot until the match ends). A failed result means the seat
    // was already gone or the match already finalized (a racing forfeit) → no-op.
    const res = this.rooms.forfeitSeat(userId);
    if (!res.ok || !res.roomId) return;

    // Audit/replay: log the departure in turn order (an explicit "left" marker) BEFORE
    // applyResult — a terminal forfeit finalizes the match there and drops the seq counter.
    this.recordAction(roomId, abandonerSeat, { gameIndex: room.match?.snapshot().gameIndex ?? 0, type: 'forfeit', cards: null });

    // Tell the table a player left. `reason` distinguishes a voluntary leave / disconnect
    // ('left') from an inactivity removal ('idle', 3 missed turns in a row) so the client
    // shows the right message. The abandoner's own client returns them to the lobby.
    this.io.to(roomId).emit('match:playerLeft', { seat: abandonerSeat, username, reason });

    // Broadcast the continuation (game events + re-armed turn timer) OR settle a
    // terminal forfeit (matchEnded → settleAndEmitMatchEnd pays / voids + frees the
    // gone seats). applyResult handles both, including the once-per-match finalize.
    this.applyResult(roomId, res);
    this.broadcastLobby();
  }

  // ---------- Tournaments: self-running bracket -------------------------------

  /** A tournament reached 'running' (just filled) or advanced a round — spin up a
   *  live room for every ready, unplayed pairing. Both players are pulled into their
   *  match (the client auto-joins on 'tournament:matchReady'); an offline/busy player
   *  forfeits by walkover so the bracket never stalls and the pool is never stranded. */
  async runTournamentMatches(tournamentId: string): Promise<void> {
    if (!this.tournaments) return;
    const t = await this.tournaments.get(tournamentId).catch(() => null);
    if (!t || t.status !== 'running') return;
    for (const m of t.bracket) {
      if (m.winnerId || !m.aUserId || !m.bUserId) continue; // decided, or not yet ready
      const key = `${tournamentId}:${m.round}:${m.index}`;
      if (this.tournamentMatchRooms.has(key)) continue; // already running
      await this.startTournamentMatch(tournamentId, m.round, m.index, m.aUserId, m.bUserId);
    }
  }

  /** Either pull both online players into a fresh room, or walk the match over when a
   *  player can't play (offline, or already busy in another room). */
  private async startTournamentMatch(tournamentId: string, round: number, index: number, a: string, b: string): Promise<void> {
    const canPlay = (uid: string) => this.socketCountFor(uid) > 0 && !this.rooms.roomIdOf(uid);
    const aReady = canPlay(a);
    const bReady = canPlay(b);
    if (!aReady && !bReady) return void this.advanceTournament(tournamentId, round, index, a); // both out → seed a
    if (!aReady) return void this.advanceTournament(tournamentId, round, index, b);
    if (!bReady) return void this.advanceTournament(tournamentId, round, index, a);

    const roomId = this.rooms.createTournamentRoom('1v1', [a, b], { tournamentId, round, index });
    this.tournamentMatchRooms.set(`${tournamentId}:${round}:${index}`, roomId);
    this.ownership?.claim(roomId);
    for (const uid of [a, b]) this.io.to(personalRoom(uid)).emit('tournament:matchReady', { roomId, tournamentId });
    const timer = setTimeout(() => void this.onTournamentNoShow(roomId, tournamentId, round, index, a, b), this.tournamentJoinMs);
    timer.unref?.();
    this.tournamentNoShowTimers.set(roomId, timer);
  }

  /** A paired player never joined in time → walk the match over to whoever did (seed a
   *  if neither), discard the un-started room. */
  private async onTournamentNoShow(roomId: string, tournamentId: string, round: number, index: number, a: string, b: string): Promise<void> {
    this.tournamentNoShowTimers.delete(roomId);
    const room = this.rooms.getRoom(roomId);
    if (!room || room.status !== 'waiting') return; // already started → the match decides it
    const winner = this.rooms.seatOf(roomId, a) >= 0 ? a : this.rooms.seatOf(roomId, b) >= 0 ? b : a;
    this.discardTournamentRoom(roomId);
    await this.advanceTournament(tournamentId, round, index, winner);
  }

  /** Tear down an un-started tournament room: detach + free any player who had joined. */
  private discardTournamentRoom(roomId: string): void {
    const room = this.rooms.getRoom(roomId);
    if (!room) return;
    for (const s of room.seats) {
      if (!s.userId) continue;
      const uid = s.userId;
      void this.io.in(personalRoom(uid)).socketsLeave(roomId);
      this.io.to(personalRoom(uid)).emit('error', { code: 'tournament_walkover', message: 'Ndeshja e turneut u vendos — kalon në raundin tjetër.' });
      this.rooms.leaveRoom(uid); // frees the seat + membership (closes the room if it empties)
    }
    this.rooms.deleteRoom(roomId); // ensure a never-joined room doesn't linger
  }

  /** Record a pairing's winner (self-running — no admin), then create the next round's
   *  rooms (or finish + pay the champion via reportResult/finish). Isolated + logged. */
  private async advanceTournament(tournamentId: string, round: number, index: number, winnerUserId: string): Promise<void> {
    if (!this.tournaments) return;
    this.tournamentMatchRooms.delete(`${tournamentId}:${round}:${index}`);
    // Record the ENGINE-decided winner so a later MANUAL admin /report for this pairing
    // is reconciled against it (admin-4): a contradicting manual winner is rejected.
    this.tournaments.recordRoomOutcome(tournamentId, round, index, winnerUserId);
    try {
      // autoFinalize: a self-running final has NO admin to confirm a four-eyes payout,
      // so it must finalize immediately (never park) — else the pool stalls forever.
      await this.tournaments.reportResult(tournamentId, round, index, winnerUserId, undefined, { autoFinalize: true });
    } catch (err) {
      // 'already_decided' (a no-show walkover already reported this pairing) and
      // 'not_running' (cancelled/swept) are benign — that path already advanced or the
      // tournament is gone. Anything else FREEZES this bracket; log loudly (the periodic
      // sweepStale eventually refunds every buy-in, so the pool is never lost).
      const code = (err as { code?: string } | null)?.code ?? 'error';
      if (code !== 'already_decided' && code !== 'not_running') {
        console.error(`[tournament] reportResult FAILED for ${tournamentId} r${round}#${index} — bracket frozen until the stale-sweep refunds:`, err);
      }
      return;
    }
    await this.runTournamentMatches(tournamentId);
  }

  /**
   * ADMIN VOID: cancel an in-progress staked match and refund EVERY stake (no
   * winner, no rake), then end the room cleanly. Reuses the same finalize claim
   * + refund path as a no-winner forfeit, so it's race-safe (a normal end / forfeit
   * racing the void: whoever claims first wins) and non-destructive — refund()
   * only adds compensating credits and is idempotent on its providerRefs. A voided
   * match awards NO XP/MMR/stats (it never counted). Returns a structured result.
   */
  async adminVoidMatch(roomId: string, meta: { adminId: string; reason: string }): Promise<AdminVoidResult> {
    const room = this.rooms.getRoom(roomId);
    if (!room) return { ok: false, reason: 'not_found' };
    if (room.status !== 'inMatch') return { ok: false, reason: 'not_in_match' };
    // Claim finalize BEFORE any await — loses to a concurrent normal-end/forfeit.
    if (!this.claimFinalize(roomId)) return { ok: false, reason: 'already_finalized' };

    const players = room.seats
      .map((s, i) => ({ seat: i, userId: s.userId }))
      .filter((p): p is { seat: number; userId: string } => p.userId !== null);
    this.clearTurnTimer(roomId);
    this.clearRoomAbandonTimers(roomId);
    this.clearRoomStrikes(roomId);
    this.clearBotTimer(roomId);

    let refunded = false;
    const matchId = this.rooms.matchIdOf(roomId);
    if (this.money && matchId) {
      try {
        await this.money.refund(matchId); // active-only, full-stake, no rake, idempotent
        refunded = true;
      } catch (err) {
        // Refund threw → the match row stays 'active', so the crash-recovery sweep
        // refunds it. Surface it (PAGE counter) and tell players it's delayed, not lost.
        settlementFailures.inc();
        // eslint-disable-next-line no-console
        console.error(`[admin-void] refund FAILED for match ${matchId} (room ${roomId}) — recovery sweep will refund:`, err);
        this.io.to(roomId).emit('error', { code: 'settlement_delayed', message: 'Shlyerja u vonua — fondet kthehen automatikisht. Na vjen keq.' });
        this.broadcastLobby();
        return { ok: true, matchId, refunded: false }; // the void DID proceed; refund follows via sweep
      }
    }
    // Intentionally NO recordMatchStats / recordRankedResult / recordAntiCheat —
    // a voided match is annulled, so it must not touch XP, MMR, or stats.
    const sb = this.rooms.scoreboardDTO(roomId);
    this.io.to(roomId).emit('match:end', {
      winnerSide: -1,
      winnerSeats: [],
      finalSideScores: sb?.cumulative ?? [],
      scoreboard: sb ?? { type: room.type, target: room.target, cumulative: [], teamTotals: null },
      payoutCents: null,
    });
    // Tell every player it was voided + refunded by an admin (not a loss).
    for (const p of players) {
      this.io.to(personalRoom(p.userId)).emit('error', { code: 'match_voided', message: 'Ndeshja u anulua nga administratori — bastet u kthyen.' });
    }
    this.revealFair(roomId);
    this.broadcastLobby();
    return { ok: true, matchId, refunded };
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
      // A bot winner returns its card itself. ALSO arm a watchdog: if driveBot hits a
      // transient early-return the seat must not stall (no human timer would rescue it).
      if (isBot(this.userAtSeat(roomId, winnerSeat))) {
        this.scheduleBot(roomId, winnerSeat);
        this.timers.armTurn(roomId, this.turnMs, () => this.onBotWatchdog(roomId, winnerSeat));
        return;
      }
      this.timers.armTurn(roomId, this.turnMs, () => this.onSwitchTimeout(roomId, winnerSeat));
      return;
    }

    const turn = snap.game?.turn;
    if (turn === null || turn === undefined) return;
    // A bot acts on its own turn (server-side); humans get the turn timer + push.
    // The watchdog guarantees a bot can NEVER hang the match if driveBot early-returns
    // (e.g. transient null state): scheduleBot normally moves it in ~1s; if the seat is
    // still the bot's after the full turn budget, the watchdog forces a legal move.
    if (isBot(this.userAtSeat(roomId, turn))) {
      this.scheduleBot(roomId, turn);
      this.timers.armTurn(roomId, this.turnMs, () => this.onBotWatchdog(roomId, turn));
      return;
    }
    this.notifyTurnIfAway(roomId, turn); // re-engagement push (isolated, fire-and-forget)
    this.timers.armTurn(roomId, this.turnMs, () => this.onTurnTimeout(roomId, turn));
  }

  /**
   * Watchdog for a bot seat. scheduleBot normally moves the bot within ~1s, which
   * re-arms the timer for the next seat and clears this. If the bot is STILL on turn
   * after the full turn budget, driveBot must have hit a transient early-return and no
   * human timer exists to rescue the seat — so retry once, then GUARANTEE progress with
   * a legal fallback (forced lead when leading, else pass). A bot never idle-forfeits.
   */
  private onBotWatchdog(roomId: string, seat: number): void {
    const room = this.rooms.getRoom(roomId);
    if (!room?.match || room.status !== 'inMatch') return;
    const userId = this.userAtSeat(roomId, seat);
    if (!isBot(userId)) return; // seat changed hands — not our concern
    const snap = room.match.snapshot();

    // Owed a card-switch return: driveBot returns the weakest eligible card itself.
    if (snap.pendingSwitch?.winner === seat) { this.driveBot(roomId, seat); return; }

    const g = snap.game;
    if (!g || g.turn !== seat) return; // bot already acted — nothing to rescue

    console.warn('[bot] watchdog: seat stalled, forcing a move', { roomId, seat });
    this.driveBot(roomId, seat); // let the normal path retry (clears most transient stalls)

    // Still owed after the retry → force a guaranteed-legal action (mirrors onTurnTimeout).
    if (this.rooms.getRoom(roomId)?.status !== 'inMatch') return;
    const after = this.rooms.getRoom(roomId)?.match?.snapshot().game;
    if (after && after.turn === seat && userId) {
      const res = after.pile === null ? this.forcedLead(roomId, userId, seat) : this.rooms.pass(userId);
      if (res.ok && res.roomId) this.applyResult(res.roomId, res);
      else this.armTurnTimer(roomId); // nothing legal happened — re-arm defensively
    }
  }

  /**
   * If the turn just passed to a player who is currently DISCONNECTED, send them a
   * "your turn" Web Push so they can come back before the timer forfeits. Isolated
   * + fire-and-forget — a push failure can never affect the turn/timer/match.
   */
  private notifyTurnIfAway(roomId: string, seat: number): void {
    if (!this.push) return;
    const s = this.rooms.getRoom(roomId)?.seats[seat];
    if (!s?.userId || s.connected) return; // only nudge a player who is away
    void this.push.notifyTurn(s.userId).catch(() => undefined);
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
      void this.forfeitMatch(roomId, seat, 'idle').catch((err) => console.error(`[forfeit] failed for room ${roomId} seat ${seat}:`, err));
      return;
    }

    const eligible = room.match.eligibleReturnCardsForWinner();
    if (eligible.length === 0) { this.armTurnTimer(roomId); return; }
    const weakest = [...eligible].sort((a, b) => singlePower(a) - singlePower(b))[0]!; // non-empty (checked)
    const res = this.rooms.switchGive(userId, weakest);
    if (res.ok && res.roomId) this.applyResult(res.roomId, res);
    else this.armTurnTimer(roomId);
  }

  private clearTurnTimer(roomId: string): void {
    this.timers.clearTurn(roomId);
  }

  private deadlineFor(roomId: string): number | null {
    return this.timers.turnDeadline(roomId);
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
      void this.forfeitMatch(roomId, seat, 'idle').catch((err) => console.error(`[forfeit] failed for room ${roomId} seat ${seat}:`, err));
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

    // During the inter-hand pause the next hand is already dealt server-side but HELD —
    // a reconnecting player must NOT be sent it (others are still on the standings screen).
    // Refresh their scoreboard instead; the real game:start reaches everyone when the gate
    // releases (startNewGameBroadcast broadcasts to the whole room, incl. this socket).
    const interHandPaused = this.interHandGates.has(roomId);
    if (pub && hand && !interHandPaused) {
      socket.emit('game:start', {
        yourSeat: seat,
        hand: [...hand],
        leader: pub.turn ?? 0,
        state: pub,
        gameIndex: snap.gameIndex,
      });
    } else if (interHandPaused) {
      const sb = this.rooms.scoreboardDTO(roomId);
      if (sb) socket.emit('match:scoreboard', sb);
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

  // Low-level seat removal + broadcast. Mid-match forfeit SETTLEMENT is NOT done here —
  // callers that leave during a match (onLeave, abandon/idle timers) run forfeitMatch()
  // first, so by the time this runs the pot is already settled/refunded.
  private leaveAndNotify(userId: string, roomId: string): void {
    const result = this.rooms.leaveRoom(userId);
    if (result.roomClosed) {
      this.clearCountdown(roomId);
      this.clearTurnTimer(roomId);
      this.clearInterHandTimer(roomId); // room gone — drop any pending inter-hand pause
      this.ownership?.release(roomId); // room gone — drop ownership claim
      this.spectatorCount.delete(roomId); // room gone — drop its spectator tally
    } else {
      this.broadcastRoomState(roomId);
      this.maybeStartCountdown(roomId);
    }
    this.broadcastLobby();
  }

  private userAtSeat(roomId: string, seat: number): string {
    const room = this.rooms.getRoom(roomId);
    return room?.seats[seat]?.userId ?? '';
  }

  private socketCountFor(userId: string): number {
    const room = this.io.sockets.adapter.rooms.get(personalRoom(userId));
    return room ? room.size : 0;
  }

  /**
   * Club chat: rate-limited, membership-derived (clubId is NOT client-supplied),
   * sanitized + mute-aware in the service. A muted sender is shadow-dropped (ack
   * ok, no broadcast). On success, broadcast to the club channel. Isolated from
   * all game/money logic.
   */
  private async onClubMessage(socket: IOSocket, payload: { text: string } | undefined, ack: (res: Ack) => void): Promise<void> {
    const reply = safeAck(ack);
    if (!this.chat) return reply(ackError('disabled', 'Chat-i nuk është aktiv.'));
    const userId = socket.data.userId;
    if (!this.limiter.allow(userId)) return reply(ackError('rate', 'Shumë mesazhe — prit pak.'));
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const res = await this.chat.send(userId, socket.data.username, text).catch(() => null);
    if (!res) return reply(ackError('error', 'Mesazhi dështoi.'));
    if (!res.ok) {
      // Shadow-mute: a muted sender is told it "sent" but nothing broadcasts.
      if (res.code === 'muted') return reply({ ok: true });
      return reply(ackError(res.code, res.code === 'no_club' ? 'Nuk je në një klub.' : 'Mesazh bosh.'));
    }
    // Ensure this socket is in the channel (covers a join-after-connect), then fan out.
    void socket.join(clubRoom(res.message.clubId));
    this.io.to(clubRoom(res.message.clubId)).emit('club:chat', res.message);
    reply({ ok: true });
  }
}

function actor(socket: IOSocket): { userId: string; username: string; avatar: string | null } {
  return { userId: socket.data.userId, username: socket.data.username, avatar: socket.data.avatar };
}
