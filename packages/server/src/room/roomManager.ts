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
}

export interface ManagerResult {
  ok: boolean;
  error?: { code: string; message: string };
}
export interface CreateResult extends ManagerResult {
  roomId?: string;
}

interface InternalSeat {
  userId: string | null;
  username: string | null;
  team: 0 | 1 | null;
  ready: boolean;
  connected: boolean;
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
      .filter((r) => !r.ranked && !r.practice && (r.status === 'waiting' || r.status === 'ready'))
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
      .filter((r) => !r.ranked && !r.practice && r.status === 'inMatch')
      .map((r) => ({
        roomId: r.id,
        type: r.type,
        target: r.target,
        players: r.seats.map((s, i) => ({ seat: i, username: s.username })),
      }));
    return { rooms, live };
  }

  // ---------- Room lifecycle --------------------------------------------------

  createRoom(user: ActingUser, payload: { type: MatchType; stakeCents: number; team?: 0 | 1; ranked?: boolean; practice?: boolean }): CreateResult {
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
    };
    this.rooms.set(room.id, room);
    if (!this.seat(room, user, payload.team)) {
      this.rooms.delete(room.id); // never leave a seat-less zombie room behind
      return err('seat_failed', 'Nuk u ul dot në dhomë.');
    }
    return { ok: true, roomId: room.id };
  }

  joinRoom(user: ActingUser, roomId: string, team?: 0 | 1): ManagerResult {
    if (this.userRoom.has(user.userId)) return err('already_in_room', 'Je tashmë në një dhomë.');
    const room = this.rooms.get(roomId);
    if (!room) return err('no_room', 'Dhoma nuk ekziston.');
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
      seat.team = null;
      seat.ready = false;
      seat.connected = false;
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
      return { ok: false, reason: 'Nuk je në një ndeshje aktive.', gameEvents: [], matchEvents: [] };
    }
    const seatIdx = room.seats.findIndex((s) => s.userId === userId);
    if (seatIdx < 0) return { ok: false, reason: 'Nuk ke vend në dhomë.', gameEvents: [], matchEvents: [] };
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

  roomStateDTO(roomId: string): RoomStateDTO | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const seats: SeatInfo[] = room.seats.map((s, i) => ({
      seat: i,
      userId: s.userId,
      username: s.username,
      team: s.team,
      ready: s.ready,
      connected: s.connected,
    }));
    return {
      id: room.id,
      type: room.type,
      stakeCents: room.stakeCents,
      status: room.status,
      seats,
      target: room.target,
      countdownMs: null, // filled by the gateway during the ready countdown
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
    s.team = room.type === '2v2' ? (TEAM_SEATS[0].includes(idx) ? 0 : 1) : null;
    s.ready = false;
    s.connected = true;
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
  return { userId: null, username: null, team: null, ready: false, connected: false };
}
