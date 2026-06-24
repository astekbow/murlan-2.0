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

/** A live (in-match) room a user can spectate. Public-safe: usernames + seats
 *  only, never cards. */
export interface LiveMatchInfo {
  roomId: string;
  type: MatchType;
  players: Array<{ seat: Seat; username: string | null }>;
  target: number;
}

export interface LobbyStateDTO {
  rooms: LobbyRoomInfo[];
  live: LiveMatchInfo[]; // in-match, non-ranked rooms open to spectators
}

// ---------- Room -------------------------------------------------------------

export interface SeatInfo {
  seat: Seat;
  userId: string | null;
  username: string | null;
  avatar: string | null; // cosmetic avatar (preset id or small data URL); null = show initials
  team: 0 | 1 | null; // 2v2 only
  ready: boolean;
  connected: boolean;
  gone?: boolean; // the player abandoned the match (left/disconnected): auto-passed + last, can't win
}

export interface RoomStateDTO {
  id: string;
  type: MatchType;
  stakeCents: number;
  status: RoomStatus;
  seats: SeatInfo[];
  target: number;          // current match target T
  countdownMs: number | null; // ready-check countdown remaining, if any
  private?: boolean;       // private rooms are hidden from the public lobby
  joinCode?: string | null; // share code for a private room (members only)
  tournament?: boolean;    // a tournament-bracket pairing — no rematch (the bracket advances itself)
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
  gone: Seat[];             // seats whose player abandoned (auto-passed, placed last)
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

/**
 * Per-player ranked rating change for a finished match — surfaced purely for
 * transparency in the match-end UI ("+18 · 41% expected"). MMR is competitive
 * /cosmetic only, never cashable. Present only when a ranked season is active;
 * the rating math (server) is unaffected by whether this is shown.
 */
export interface RankedDeltaDTO {
  userId: string;
  oldRating: number;
  newRating: number;
  tierKey: RankedTierKey;
  won: boolean;
  expectedWinRate: number; // 0..1 — Elo expected score vs the field's average
}

export interface MatchEndDTO {
  winnerSide: number;
  winnerSeats: Seat[];
  finalSideScores: number[];
  scoreboard: ScoreboardDTO;
  payoutCents: number | null; // populated once money settlement exists (Phase 6)
  ratingDeltas?: RankedDeltaDTO[]; // present only when a ranked season is active
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

// ---------- Ranked / seasons (competitive MMR — never cashable) --------------

export type RankedTierKey = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'master';

/** A rank tier for the client to render a badge; `next` is the tier above (if any). */
export interface TierInfo {
  key: RankedTierKey;
  name: string;   // Albanian, player-facing
  min: number;    // inclusive lower rating bound
  color: string;  // hex
  emoji: string;
  next: { key: RankedTierKey; name: string; min: number } | null;
}

export type SeasonStatusDTO = 'active' | 'archived';

export interface SeasonDTO {
  id: string;
  number: number;
  name: string;
  status: SeasonStatusDTO;
  startedAt: number;       // epoch ms
  endedAt: number | null;
}

/** A viewer's own ranked standing in the active season (null season ⇒ ranked off). */
export interface RankedProfileDTO {
  season: SeasonDTO | null;
  rating: number;
  peakRating: number;
  tier: TierInfo;
  games: number;
  wins: number;
  winRate: number; // 0..1
}

/** A club chat message (broadcast to club members + returned in history). */
export interface ChatMessageDTO {
  id: string;
  clubId: string;
  userId: string;
  username: string;
  text: string;
  createdAt: number; // epoch ms
}

export interface RankedLeaderboardRow {
  rank: number;
  userId: string;
  username: string;
  avatar: string | null;
  rating: number;
  peakRating: number;
  tier: TierInfo;
  games: number;
  wins: number;
  winRate: number;
}

// ---------- Replay / move-log (deterministic match playback + audit) --------

export interface ReplayActionDTO {
  seq: number;       // turn order within the match
  gameIndex: number; // which game within the match
  seat: Seat;
  type: 'play' | 'pass' | 'switch' | 'forfeit'; // 'forfeit' = the player abandoned the match here
  cards: Card[] | null; // played cards / given card; null for a pass / forfeit
}

export interface ReplayGameDTO {
  index: number;
  nonce: number;
  revealed: boolean;
  serverSeed: string | null; // published only once the match revealed it
}

/** Everything needed to replay a finished match: the deal seeds + the move-log. */
export interface ReplayDTO {
  matchId: string;
  revealed: boolean;            // all deals' server seeds published (verifiable)
  numPlayers: number;           // derived from the move-log (deal reproduction)
  serverSeedHash: string | null;
  clientSeed: string | null;
  games: ReplayGameDTO[];
  actions: ReplayActionDTO[];
}

// ---------- VIP / loyalty (status only — rake-back cashout is payment-gated) -

export type VipTierKey = 'standard' | 'bronze' | 'silver' | 'gold' | 'diamond';

export interface VipTierInfo {
  key: VipTierKey;
  name: string;        // Albanian, player-facing
  minStakedCents: number; // lifetime staked volume to reach this tier (the level)
  color: string;
}

export interface VipStatusDTO {
  stakedCents: number;          // lifetime staked volume (loyalty)
  tier: VipTierInfo;
  next: VipTierInfo | null;     // the tier above, if any
  toNextCents: number;          // staked volume still needed for `next` (0 at top)
}

// ---------- Clubs (social) --------------------------------------------------

export type ClubRoleDTO = 'founder' | 'member';

export interface ClubMemberDTO {
  userId: string;
  username: string;
  avatar: string | null;
  role: ClubRoleDTO;
}

export interface ClubSummaryDTO {
  id: string;
  name: string;
  tag: string;
  founderId: string;
  createdAt: number;
  memberCount: number;
}

export interface ClubDetailDTO extends ClubSummaryDTO {
  members: ClubMemberDTO[];
  private?: boolean;
  joinCode?: string | null; // members see it so they can share/invite friends
}

// ---------- Errors -----------------------------------------------------------

export interface ErrorDTO {
  code: string;
  message: string; // Albanian, player-facing
}
