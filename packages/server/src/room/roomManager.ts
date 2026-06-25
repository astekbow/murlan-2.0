// ============================================================================
// MURLAN — Room & Lobby manager (Phase 4c)
// ----------------------------------------------------------------------------
// Authoritative orchestration over the Match state machine: lobby listing,
// room creation/join/leave, seating (with 2v2 teams), ready-check, match start,
// and forwarding play/pass/switchGive to the Match. PURE of timers and sockets
// — the gateway (4d) owns real timers and translates results into emissions.
// Dealing is injected so production uses crypto/provably-fair RNG and tests use
// scripted hands. Money (stake debit) is deliberately NOT here — that is Phase 6.
// ============================================================================

import type { Card } from '@murlan/engine';
import { deal as engineDeal } from '@murlan/engine';
import type {
  MatchType, LobbyStateDTO, RoomStateDTO, PublicGameStateDTO, ScoreboardDTO, SeatInfo,
} from '@murlan/shared';
import { PLAYERS_PER_TYPE } from '@murlan/shared';
import { randomBytes } from 'node:crypto';
import { Match, type MatchActionResult } from '../match/match.ts';
import { teamTotals, DEFAULT_TEAMS } from '../match/scoring.ts';
import { cryptoRng } from '../util/rng.ts';

export interface ActingUser {
  userId: string;
  username: string;
  avatar?: string | null; // cosmetic avatar; carried onto the seat so it shows at the table/room
}

export interface ManagerResult {
  ok: boolean;
  error?: { code: string; message: string };
}
export interface CreateResult extends ManagerResult {
  roomId?: string;
  joinCode?: string; // present for a private room — share it so friends can join
}

// Shareable private-room codes are DIGITS ONLY (easy to read out + type on a phone).
const CODE_ALPHABET = '0123456789';
const CODE_LEN = 6;
function genJoinCode(): string {
  const b = randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[b[i]! % CODE_ALPHABET.length];
  return s;
}

interface InternalSeat {
  userId: string | null;
  username: string | null;
  avatar: string | null;
  team: 0 | 1 | null;
  ready: boolean;
  connected: boolean;
  gone: boolean; // player abandoned the match (kept seated for display/stats/pot; freed at match end)
}

interface Room {
  id: string;
  type: MatchType;
  stakeCents: number;
  status: RoomStateDTO['status'];
  seats: InternalSeat[];
  target: number;
  match: Match | null;
  matchId: string | null; // unique per match instance (NOT the reusable room id)
  matchSeq: number;
  createdAt: number;
  ranked: boolean; // auto-formed by matchmaking; hidden from the public lobby
  practice: boolean; // vs-bot practice room; zero-stake, hidden from lobby + spectators
  private: boolean; // invite/code-only; hidden from the public lobby
  joinCode: string | null; // share code for a private room (null otherwise)
  // Allow-list for a PLAIN private room (not tournament/clubWar, which gate by their own
  // player list): a user may join only if explicitly invited OR after redeeming the joinCode.
  // Without this, a guessed/observed sequential roomId let anyone walk into a private staked game.
  invited: Set<string>;
  // When set, this room is one pairing of a running tournament bracket: zero-stake
  // (the buy-ins are escrowed in the tournament pool), join-restricted to the two
  // paired players, and its result advances the bracket (see the gateway runner).
  tournament: TournamentRoomMeta | null;
  // When set, this room is one pairing of a running Club War: zero-stake (buy-ins are
  // escrowed in the war pool), join-restricted to the two paired players, and its result
  // is reported to the ClubWarService (see the gateway).
  clubWar: ClubWarRoomMeta | null;
}

export interface TournamentRoomMeta {
  tournamentId: string;
  round: number;
  index: number;
  players: [string, string]; // the only two userIds allowed to join this room
}

export interface ClubWarRoomMeta {
  warId: string;
  aUserId: string; // the club-A player (pairing canonical order)
  bUserId: string; // the club-B player
  players: [string, string]; // the only two userIds allowed to join this room
}

const err = (code: string, message: string): ManagerResult => ({ ok: false, error: { code, message } });
const okResult: ManagerResult = { ok: true };

// 2v2 team -> the seats that belong to it (mirrors scoring.DEFAULT_TEAMS).
const TEAM_SEATS: [number[], number[]] = DEFAULT_TEAMS;

export interface RoomManagerOptions {
  /** Builds a dealer for a freshly started match. Injected for deterministic tests. */
  dealerFactory?: (numPlayers: 2 | 3 | 4) => () => Card[][];
  startTarget?: number; // default 21
  idFactory?: () => string;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private userRoom = new Map<string, string>(); // userId -> roomId
  private readonly dealerFactory: (n: 2 | 3 | 4) => () => Card[][];
  private readonly startTarget: number;
  private readonly newId: () => string;
  private seq = 0;
  // Per-process token mixed into every matchId so ids stay globally unique
  // ACROSS server restarts. Room ids (`room_<seq>`) reset to 1 on each boot, but
  // match rows persist in Postgres — without this tag a replayed room_1-m1 would
  // collide with a settled match and silently skip escrow.
  private readonly instanceTag = randomBytes(3).toString('hex');

  constructor(opts: RoomManagerOptions = {}) {
    this.dealerFactory =
      opts.dealerFactory ??
      ((numPlayers) => {
        const rng = cryptoRng();
        return () => engineDeal(numPlayers, rng);
      });
    this.startTarget = opts.startTarget ?? 21;
    this.newId = opts.idFactory ?? (() => `room_${(this.seq += 1)}`);
  }

  // ---------- Lobby -----------------------------------------------------------

  listLobby(): LobbyStateDTO {
    const all = [...this.rooms.values()];
    // Ranked rooms are auto-formed by matchmaking and auto-start — never list
    // them publicly (no one can join, and they're meant for the matched players).
    const rooms = all
      .filter((r) => !r.ranked && !r.practice && !r.private && (r.status === 'waiting' || r.status === 'ready'))
      .map((r) => ({
        id: r.id,
        type: r.type,
        stakeCents: r.stakeCents,
        seatsFilled: r.seats.filter((s) => s.userId !== null).length,
        seatsTotal: r.seats.length,
        status: r.status,
        createdAt: r.createdAt,
      }));
    // Live (in-match) rooms anyone can spectate — usernames + seats only, no cards.
    const live = all
      .filter((r) => !r.ranked && !r.practice && !r.private && r.status === 'inMatch')
      .map((r) => ({
        roomId: r.id,
        type: r.type,
        target: r.target,
        players: r.seats.map((s, i) => ({ seat: i, username: s.username })),
      }));
    return { rooms, live };
  }

  // ---------- Room lifecycle --------------------------------------------------

  createRoom(user: ActingUser, payload: { type: MatchType; stakeCents: number; team?: 0 | 1; ranked?: boolean; practice?: boolean; private?: boolean }): CreateResult {
    if (this.userRoom.has(user.userId)) {
      return err('already_in_room', 'Je tashmë në një dhomë.');
    }
    if (!Number.isInteger(payload.stakeCents) || payload.stakeCents < 0) {
      return err('bad_stake', 'Shuma e bastit është e pavlefshme.');
    }
    // Reject an unknown match type: an invalid type yields PLAYERS_PER_TYPE[type]
    // === undefined → a 0-seat room that can never be seated, left, or joined and
    // pollutes the lobby forever. (The gateway also validates; this is the
    // second line so direct/test callers are safe too.)
    const n = PLAYERS_PER_TYPE[payload.type];
    if (!n) return err('bad_type', 'Lloji i ndeshjes është i pavlefshëm.');
    const isPrivate = !!payload.private;
    const room: Room = {
      id: this.newId(),
      type: payload.type,
      stakeCents: payload.stakeCents,
      status: 'waiting',
      seats: Array.from({ length: n }, () => emptySeat()),
      target: this.startTarget,
      match: null,
      matchId: null,
      matchSeq: 0,
      createdAt: Date.now(),
      ranked: !!payload.ranked,
      practice: !!payload.practice,
      private: isPrivate,
      joinCode: isPrivate ? genJoinCode() : null,
      invited: new Set(),
      clubWar: null,
      tournament: null,
    };
    this.rooms.set(room.id, room);
    if (!this.seat(room, user, payload.team)) {
      this.rooms.delete(room.id); // never leave a seat-less zombie room behind
      return err('seat_failed', 'Nuk u ul dot në dhomë.');
    }
    return { ok: true, roomId: room.id, joinCode: room.joinCode ?? undefined };
  }

  /** Create an EMPTY 2-seat zero-stake room for ONE tournament pairing. The two paired
   *  players join it via the normal join flow (gateway-gated to them); the match result
   *  advances the bracket. Buy-ins are escrowed in the tournament pool, so the room
   *  itself never escrows. Returns the new room id. */
  createTournamentRoom(type: MatchType, players: [string, string], meta: { tournamentId: string; round: number; index: number }): string {
    const n = PLAYERS_PER_TYPE[type];
    const room: Room = {
      id: this.newId(),
      type,
      stakeCents: 0,
      status: 'waiting',
      seats: Array.from({ length: n }, () => emptySeat()),
      target: this.startTarget,
      match: null,
      matchId: null,
      matchSeq: 0,
      createdAt: Date.now(),
      ranked: false,
      practice: false,
      private: true, // never in the public lobby
      joinCode: null,
      invited: new Set(),
      tournament: { tournamentId: meta.tournamentId, round: meta.round, index: meta.index, players: [...players] as [string, string] },
      clubWar: null,
    };
    this.rooms.set(room.id, room);
    return room.id;
  }

  /** The tournament pairing this room is running, or null for a normal room. */
  tournamentMetaOf(roomId: string): TournamentRoomMeta | null {
    return this.rooms.get(roomId)?.tournament ?? null;
  }

  /** Create an EMPTY 2-seat zero-stake room for ONE Club War pairing (join-restricted to the
   *  two paired players; buy-ins are escrowed in the war pool, so the room never escrows). */
  createClubWarRoom(players: [string, string], meta: { warId: string; aUserId: string; bUserId: string }): string {
    const room: Room = {
      id: this.newId(),
      type: '1v1',
      stakeCents: 0,
      status: 'waiting',
      seats: Array.from({ length: PLAYERS_PER_TYPE['1v1'] }, () => emptySeat()),
      target: this.startTarget,
      match: null,
      matchId: null,
      matchSeq: 0,
      createdAt: Date.now(),
      ranked: false,
      practice: false,
      private: true, // never in the public lobby
      joinCode: null,
      invited: new Set(),
      tournament: null,
      clubWar: { warId: meta.warId, aUserId: meta.aUserId, bUserId: meta.bUserId, players: [...players] as [string, string] },
    };
    this.rooms.set(room.id, room);
    return room.id;
  }

  /** The Club War pairing this room is running, or null for a normal room. */
  clubWarMetaOf(roomId: string): ClubWarRoomMeta | null {
    return this.rooms.get(roomId)?.clubWar ?? null;
  }

  /** Resolve a private-room share code → its room id (case-insensitive). */
  roomIdForCode(code: string): string | null {
    const c = code.trim().toUpperCase();
    if (!c) return null;
    for (const r of this.rooms.values()) if (r.private && r.joinCode === c) return r.id;
    return null;
  }

  /** Authorize a user to join a plain private room (explicit friend invite, or after they
   *  redeemed the share code). No-op for a non-existent room. */
  markInvited(roomId: string, userId: string): void {
    this.rooms.get(roomId)?.invited.add(userId);
  }

  joinRoom(user: ActingUser, roomId: string, team?: 0 | 1): ManagerResult {
    if (this.userRoom.has(user.userId)) return err('already_in_room', 'Je tashmë në një dhomë.');
    const room = this.rooms.get(roomId);
    if (!room) return err('no_room', 'Dhoma nuk ekziston.');
    // A tournament pairing room only admits its two paired players (no walk-ins).
    if (room.tournament && !room.tournament.players.includes(user.userId)) return err('not_your_match', 'Kjo ndeshje turneu nuk është e jotja.');
    if (room.clubWar && !room.clubWar.players.includes(user.userId)) return err('not_your_match', 'Kjo ndeshje lufte nuk është e jotja.');
    // A PLAIN private room (no tournament/clubWar gate) admits only invited users or code-redeemers.
    // Blocks walking in with a guessed/observed roomId (room ids are sequential → enumerable).
    if (room.private && !room.tournament && !room.clubWar && !room.invited.has(user.userId)) {
      return err('not_invited', 'Kjo dhomë private kërkon ftesë ose kod.');
    }
    if (room.status !== 'waiting') return err('room_unavailable', 'Dhoma nuk pranon lojtarë të rinj.');
    if (!this.seat(room, user, team)) return err('room_full', 'Dhoma është plot ose ekipi është plot.');
    return okResult;
  }

  /** Remove a user from their room. Returns whether the room became empty/closed. */
  leaveRoom(userId: string): { ok: boolean; roomId?: string; roomClosed?: boolean } {
    const roomId = this.userRoom.get(userId);
    if (!roomId) return { ok: false };
    const room = this.rooms.get(roomId);
    if (!room) {
      this.userRoom.delete(userId);
      return { ok: false };
    }
    const seat = room.seats.find((s) => s.userId === userId);
    if (seat) {
      seat.userId = null;
      seat.username = null;
      seat.avatar = null;
      seat.team = null;
      seat.ready = false;
      seat.connected = false;
      seat.gone = false;
    }
    this.userRoom.delete(userId);

    // If nobody is left, close the room. Otherwise, a player leaving during a
    // waiting room re-opens it; leaving mid-match is an abandon (settlement
    // policy is Phase 6 — here we just free the seat).
    const occupied = room.seats.some((s) => s.userId !== null);
    if (!occupied) {
      this.rooms.delete(roomId);
      return { ok: true, roomId, roomClosed: true };
    }
    if (room.status === 'ready') room.status = 'waiting';
    return { ok: true, roomId, roomClosed: false };
  }

  setReady(userId: string, ready: boolean): ManagerResult {
    const room = this.roomOf(userId);
    if (!room) return err('no_room', 'Nuk je në një dhomë.');
    const seat = room.seats.find((s) => s.userId === userId);
    if (!seat) return err('no_seat', 'Nuk ke vend në dhomë.');
    if (room.status === 'inMatch') return err('in_match', 'Ndeshja ka filluar tashmë.');
    seat.ready = ready;
    return okResult;
  }

  isFull(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return !!room && room.seats.every((s) => s.userId !== null);
  }

  allReady(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return !!room && room.seats.every((s) => s.userId !== null && s.ready);
  }

  /**
   * Begin the match: deal game 1 and enter live play. A `dealer` may be injected
   * (the gateway passes the provably-fair dealer); otherwise the default is used.
   */
  startMatch(roomId: string, dealer?: () => Card[][]): ManagerResult {
    const room = this.rooms.get(roomId);
    if (!room) return err('no_room', 'Dhoma nuk ekziston.');
    if (room.status === 'inMatch') return err('in_match', 'Ndeshja ka filluar tashmë.');
    if (!this.isFull(roomId)) return err('not_full', 'Dhoma nuk është plot.');

    const n = PLAYERS_PER_TYPE[room.type];
    room.match = new Match({
      type: room.type,
      deal: dealer ?? this.dealerFactory(n),
      startTarget: room.target,
      teams: room.type === '2v2' ? [[...TEAM_SEATS[0]], [...TEAM_SEATS[1]]] : undefined,
    });
    room.status = 'inMatch';
    room.target = room.match.currentTarget;
    return okResult;
  }

  // ---------- Game actions (forwarded to the Match) ---------------------------

  play(userId: string, cards: Card[]): MatchActionResult & { roomId?: string } {
    return this.forward(userId, (room, seat) => room.match!.play(seat, cards));
  }
  pass(userId: string): MatchActionResult & { roomId?: string } {
    return this.forward(userId, (room, seat) => room.match!.pass(seat));
  }
  switchGive(userId: string, card: Card): MatchActionResult & { roomId?: string } {
    return this.forward(userId, (room, seat) => room.match!.switchGive(seat, card));
  }

  private forward(
    userId: string,
    action: (room: Room, seat: number) => MatchActionResult,
  ): MatchActionResult & { roomId?: string } {
    const room = this.roomOf(userId);
    if (!room || !room.match || room.status !== 'inMatch') {
      return { ok: false, reason: 'Nuk je në një ndeshje aktive.', code: 'not_in_match', gameEvents: [], matchEvents: [] };
    }
    const seatIdx = room.seats.findIndex((s) => s.userId === userId);
    if (seatIdx < 0) return { ok: false, reason: 'Nuk ke vend në dhomë.', code: 'no_seat', gameEvents: [], matchEvents: [] };
    const res = action(room, seatIdx);
    // Reflect a finished match back into the room status.
    if (room.match.currentState === 'matchOver') {
      room.status = 'finished';
      room.target = room.match.currentTarget;
    } else {
      room.target = room.match.currentTarget;
    }
    return { ...res, roomId: room.id };
  }

  /**
   * A seated player abandons the LIVE match (left / disconnect grace expired /
   * idled out). Mark the seat `gone` in the engine — the match plays on without
   * them (auto-passed, placed last) or ends if too few remain — and free them
   * from `userRoom` so they can join another room. The seat KEEPS its userId so
   * the quitter still appears at the table, is counted in the pot, and takes the
   * loss/MMR hit at settlement; it is freed (nulled) after the match ends via
   * clearGoneSeats. Returns the match events to broadcast (with `roomId`).
   */
  forfeitSeat(userId: string): MatchActionResult & { roomId?: string } {
    const room = this.roomOf(userId);
    if (!room || !room.match || room.status !== 'inMatch') {
      return { ok: false, reason: 'Nuk je në një ndeshje aktive.', code: 'not_in_match', gameEvents: [], matchEvents: [] };
    }
    const seatIdx = room.seats.findIndex((s) => s.userId === userId);
    if (seatIdx < 0) return { ok: false, reason: 'Nuk ke vend në dhomë.', code: 'no_seat', gameEvents: [], matchEvents: [] };
    const res = room.match.forfeit(seatIdx);
    if (res.ok) {
      const seat = room.seats[seatIdx]!;
      seat.gone = true;
      seat.connected = false;
      seat.ready = false;
      this.userRoom.delete(userId); // free them to join elsewhere; seat kept for display/stats/pot
    }
    if (room.match.currentState === 'matchOver') room.status = 'finished';
    room.target = room.match.currentTarget;
    return { ...res, roomId: room.id };
  }

  /** Reset a FINISHED room to a fresh waiting state for a REMATCH: same roster, seats,
   *  teams, stake and type — only the match is cleared, ready flags dropped, and the
   *  target reset to a fresh game (so the rematch is a new match to startTarget, not a
   *  continuation). The next beginMatch mints a new matchId + re-escrows via the normal
   *  path. Valid ONLY from 'finished' (and never a tournament/ranked room — the caller
   *  gates that). Returns false if the room isn't resettable. */
  resetForRematch(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'finished') return false;
    if (room.tournament) return false; // bracket rooms never rematch
    room.match = null;
    room.target = this.startTarget;
    room.status = 'waiting';
    for (const s of room.seats) s.ready = false;
    return true;
  }

  /** After a match ends, free every seat whose player had abandoned (so a rematch
   *  starts clean). Present players keep their seats. */
  clearGoneSeats(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const s of room.seats) {
      if (s.gone) {
        s.userId = null;
        s.username = null;
        s.avatar = null;
        s.team = null;
        s.ready = false;
        s.connected = false;
        s.gone = false;
      }
    }
  }

  // ---------- Connection tracking (reconnection support) ----------------------

  setConnected(userId: string, connected: boolean): void {
    const room = this.roomOf(userId);
    const seat = room?.seats.find((s) => s.userId === userId);
    if (seat) seat.connected = connected;
  }

  /** Active (in-match) rooms, summarised for the admin panel. */
  listActiveMatches(): Array<{
    roomId: string;
    matchId: string | null;
    type: MatchType;
    stakeCents: number;
    target: number;
    players: Array<{ seat: number; username: string | null; connected: boolean }>;
  }> {
    return [...this.rooms.values()]
      .filter((r) => r.status === 'inMatch')
      .map((r) => ({
        roomId: r.id,
        matchId: r.matchId,
        type: r.type,
        stakeCents: r.stakeCents,
        target: r.target,
        players: r.seats
          .filter((s) => s.userId !== null)
          .map((s, _i) => ({ seat: r.seats.indexOf(s), username: s.username, connected: s.connected })),
      }));
  }

  /** Allocate a fresh unique match id for the next match in this room. */
  assignMatchId(roomId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.matchSeq += 1;
    room.matchId = `${roomId}-m${room.matchSeq}-${this.instanceTag}`;
    return room.matchId;
  }

  /** The current match's unique id (distinct from the reusable room id). */
  matchIdOf(roomId: string): string | null {
    return this.rooms.get(roomId)?.matchId ?? null;
  }

  /** Match ids the live server still owns (in-match rooms). Used by the
   *  crash-recovery sweep to avoid refunding a genuinely in-progress match. */
  activeMatchIds(): Set<string> {
    const ids = new Set<string>();
    for (const room of this.rooms.values()) {
      if (room.matchId && room.status === 'inMatch') ids.add(room.matchId);
    }
    return ids;
  }

  /** Force-remove a room (e.g. a never-started tournament pairing walked over). Frees
   *  any lingering userRoom mapping defensively so its players aren't trapped. */
  deleteRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const s of room.seats) if (s.userId) this.userRoom.delete(s.userId);
    this.rooms.delete(roomId);
  }

  /** Force a room to the finished state (e.g. on forfeit). */
  markFinished(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.status = 'finished';
      if (room.match) room.target = room.match.currentTarget;
    }
  }

  // ---------- Lookups & DTOs --------------------------------------------------

  roomOf(userId: string): Room | null {
    const id = this.userRoom.get(userId);
    return id ? this.rooms.get(id) ?? null : null;
  }

  roomIdOf(userId: string): string | null {
    return this.userRoom.get(userId) ?? null;
  }

  seatOf(roomId: string, userId: string): number {
    const room = this.rooms.get(roomId);
    return room ? room.seats.findIndex((s) => s.userId === userId) : -1;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Flag a ZERO-STAKE room as practice (no XP/ranked/stats; money is already gated
   *  on stake>0) — used when a free lobby is auto-filled with fill-players so playing
   *  against them can never farm rewards. No-op (and refused) on a staked room. */
  markPractice(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.stakeCents === 0) room.practice = true;
  }

  roomStateDTO(roomId: string): RoomStateDTO | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const seats: SeatInfo[] = room.seats.map((s, i) => ({
      seat: i,
      userId: s.userId,
      username: s.username,
      avatar: s.avatar,
      team: s.team,
      ready: s.ready,
      connected: s.connected,
      gone: s.gone,
    }));
    return {
      id: room.id,
      type: room.type,
      stakeCents: room.stakeCents,
      status: room.status,
      seats,
      target: room.target,
      countdownMs: null, // filled by the gateway during the ready countdown
      private: room.private,
      joinCode: room.joinCode, // members see it so they can share/invite
      tournament: room.tournament !== null, // bracket pairing → client hides the rematch button
    };
  }

  publicGameDTO(roomId: string, turnDeadline: number | null = null): PublicGameStateDTO | null {
    const room = this.rooms.get(roomId);
    const snap = room?.match?.snapshot().game;
    if (!snap) return null;
    return {
      status: snap.status,
      turn: snap.turn,
      pile: snap.pile,
      pileOwner: snap.pileOwner,
      handCounts: snap.handCounts,
      active: snap.active,
      passed: snap.passed,
      finishingOrder: snap.finishingOrder,
      gone: snap.gone,
      turnDeadline,
    };
  }

  /** The PRIVATE hand for a seat — only ever sent to that seat's own socket. */
  handOf(roomId: string, seat: number): readonly Card[] | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.match) return null;
    return room.match.handOf(seat);
  }

  scoreboardDTO(roomId: string): ScoreboardDTO | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.match) return null;
    const snap = room.match.snapshot();
    return {
      type: room.type,
      target: snap.target,
      cumulative: snap.cumulative,
      teamTotals: room.type === '2v2' ? teamTotals(snap.cumulative, [[...TEAM_SEATS[0]], [...TEAM_SEATS[1]]]) : null,
    };
  }

  // ---------- Seating ---------------------------------------------------------

  private seat(room: Room, user: ActingUser, team?: 0 | 1): boolean {
    const idx = this.pickSeat(room, team);
    if (idx < 0) return false;
    const s = room.seats[idx]!; // pickSeat returns a valid in-bounds seat index (or <0)
    s.userId = user.userId;
    s.username = user.username;
    s.avatar = user.avatar ?? null;
    s.team = room.type === '2v2' ? (TEAM_SEATS[0].includes(idx) ? 0 : 1) : null;
    s.ready = false;
    s.connected = true;
    s.gone = false;
    this.userRoom.set(user.userId, room.id);
    if (this.isFull(room.id)) room.status = 'ready';
    return true;
  }

  private pickSeat(room: Room, team?: 0 | 1): number {
    const open = (i: number) => room.seats[i]!.userId === null; // i ranges over valid seat indices
    if (room.type === '2v2' && team !== undefined) {
      const seatsForTeam = TEAM_SEATS[team];
      const free = seatsForTeam.find(open);
      return free === undefined ? -1 : free;
    }
    for (let i = 0; i < room.seats.length; i++) if (open(i)) return i;
    return -1;
  }
}

function emptySeat(): InternalSeat {
  return { userId: null, username: null, avatar: null, team: null, ready: false, connected: false, gone: false };
}
