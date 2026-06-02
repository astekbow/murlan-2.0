// ============================================================================
// MURLAN — Shared DTOs & enums
// ----------------------------------------------------------------------------
// The contract between server and client. Public/broadcast DTOs carry ONLY
// information a client is allowed to see: opponents are represented by card
// COUNTS, never card identities. A player's own cards travel only in the
// private `GameStartDTO.hand` / `HandDTO` addressed to that player's socket.
// ============================================================================

import type { Card, Combo } from '@murlan/engine';

export type { Card, Combo } from '@murlan/engine';

export type MatchType = '1v1' | '1v1v1' | '2v2';

export const PLAYERS_PER_TYPE: Record<MatchType, 2 | 3 | 4> = {
  '1v1': 2,
  '1v1v1': 3,
  '2v2': 4,
};

export type RoomStatus =
  | 'waiting'   // open, filling seats
  | 'ready'     // all seats filled, running ready-check / countdown
  | 'inMatch'   // a match is being played
  | 'finished'; // match over, room closing

export type Seat = number;

// ---------- Lobby ------------------------------------------------------------

export interface LobbyRoomInfo {
  id: string;
  type: MatchType;
  stakeCents: number;
  seatsFilled: number;
  seatsTotal: number;
  status: RoomStatus;
  createdAt: number; // epoch ms (server-stamped)
}

export interface LobbyStateDTO {
  rooms: LobbyRoomInfo[];
}

// ---------- Room -------------------------------------------------------------

export interface SeatInfo {
  seat: Seat;
  userId: string | null;
  username: string | null;
  team: 0 | 1 | null; // 2v2 only
  ready: boolean;
  connected: boolean;
}

export interface RoomStateDTO {
  id: string;
  type: MatchType;
  stakeCents: number;
  status: RoomStatus;
  seats: SeatInfo[];
  target: number;          // current match target T
  countdownMs: number | null; // ready-check countdown remaining, if any
}

// ---------- Game (public, broadcast-safe) ------------------------------------

export type ComboType = Combo['type'];

export interface PublicGameStateDTO {
  status: 'playing' | 'finished';
  turn: Seat | null;
  pile: Combo | null;       // the public pile on the table (cards are face-up)
  pileOwner: Seat | null;
  handCounts: number[];     // cards remaining per seat — NEVER identities
  active: boolean[];
  passed: Seat[];
  finishingOrder: Seat[];
  turnDeadline: number | null; // epoch ms when the current turn auto-resolves
}

/** Private payload addressed to a single player: their own hand + public counts. */
export interface GameStartDTO {
  yourSeat: Seat;
  hand: Card[];             // ONLY this recipient's cards
  leader: Seat;
  state: PublicGameStateDTO;
  gameIndex: number;
}

/** A refreshed private hand (e.g. after the card switch or on reconnect). */
export interface HandDTO {
  yourSeat: Seat;
  hand: Card[];
}

// ---------- Scoring / match --------------------------------------------------

export interface ScoreboardDTO {
  type: MatchType;
  target: number;
  cumulative: number[];          // per-seat
  teamTotals: [number, number] | null; // 2v2 only
}

export interface TrickWonDTO {
  winner: Seat;
  leadsNext: Seat | null;
}

export interface PlayerFinishedDTO {
  seat: Seat;
  place: number; // 1-based
}

export interface GameEndDTO {
  gameIndex: number;
  finishingOrder: Seat[];
  points: number[];      // per-seat for this game
  scoreboard: ScoreboardDTO;
}

/**
 * Card-switch reveal. Sent in FULL only to the two participants (winner/loser);
 * other clients receive it with `given`/`returned` set to null (a switch
 * happened, identities withheld) to avoid leaking hidden cards.
 */
export interface CardSwitchDTO {
  winner: Seat;
  loser: Seat;
  given: Card | null;    // loser's strongest card -> winner
  returned: Card | null; // winner's rank-3–10 card -> loser (null if none/withheld)
  awaitingReturn: boolean; // true while the winner still has to choose
}

export interface MatchEndDTO {
  winnerSide: number;
  winnerSeats: Seat[];
  finalSideScores: number[];
  scoreboard: ScoreboardDTO;
  payoutCents: number | null; // populated once money settlement exists (Phase 6)
}

// ---------- Provably-fair shuffle (spec §8) ---------------------------------

/**
 * Sent before clientSeeds are collected: the commitment players hold until the
 * reveal. Clients respond with their own clientSeed AFTER receiving this, which
 * is what makes the deal un-grindable (serverSeed is fixed before clientSeed).
 */
export interface FairCommitDTO {
  serverSeedHash: string; // hash(serverSeed) — serverSeed stays secret until reveal
}

/** Sent after a match so any player can recompute & verify every deal. */
export interface FairRevealDTO {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  numPlayers: 2 | 3 | 4; // needed to reproduce the deal independently
  gameCount: number;     // deals were made with nonce = 0 .. gameCount-1
  matchId?: string;      // links to the durable public verify endpoint
}

// ---------- Errors -----------------------------------------------------------

export interface ErrorDTO {
  code: string;
  message: string; // Albanian, player-facing
}
