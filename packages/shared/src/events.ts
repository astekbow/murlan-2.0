// ============================================================================
// MURLAN — Socket.IO event contract
// ----------------------------------------------------------------------------
// Typed event maps shared by the server (io: Server<C2S, S2C>) and the client
// (socket: Socket<S2C, C2S>). Adding/renaming an event here updates both ends.
// ============================================================================

import type { Card } from '@murlan/engine';
import type {
  MatchType, LobbyStateDTO, RoomStateDTO, GameStartDTO, HandDTO,
  PublicGameStateDTO, TrickWonDTO, PlayerFinishedDTO, GameEndDTO,
  CardSwitchDTO, ScoreboardDTO, MatchEndDTO, ErrorDTO, Seat,
  FairCommitDTO, FairRevealDTO, ChatMessageDTO,
} from './types.ts';

// ---------- Client -> Server -------------------------------------------------

export interface RoomCreatePayload {
  type: MatchType;
  stakeCents: number;
  team?: 0 | 1; // 2v2 preferred team (optional; auto-assigned otherwise)
  private?: boolean; // hidden from the public lobby; join by code/invite only
}
export interface RoomJoinPayload {
  roomId: string;
  team?: 0 | 1;
}
export interface RoomJoinByCodePayload {
  code: string; // a private room's share code
}
export interface GamePlayPayload {
  cards: Card[];
}
export interface SwitchGivePayload {
  card: Card; // the winner's rank-3–10 card to return to the loser
}

/** Generic ack so clients can await success/failure of an intent. */
export interface Ack {
  ok: boolean;
  error?: ErrorDTO;
  roomId?: string;
  joinCode?: string; // returned when creating a private room (share it with friends)
}

/** Ranked matchmaking queue status pushed to a waiting player. */
export interface RankedQueueDTO {
  inQueue: boolean;
  matchType: MatchType | null;
  size: number;   // players currently waiting for this match type
  needed: number; // players required to start (PLAYERS_PER_TYPE)
}

export interface ClientToServerEvents {
  // `auth` is handled in the Socket.IO handshake (token), but kept for re-auth.
  'auth': (token: string, ack: (res: Ack) => void) => void;
  'lobby:list': (ack: (state: LobbyStateDTO) => void) => void;
  'room:create': (payload: RoomCreatePayload, ack: (res: Ack) => void) => void;
  'room:join': (payload: RoomJoinPayload, ack: (res: Ack) => void) => void;
  'room:joinByCode': (payload: RoomJoinByCodePayload, ack: (res: Ack) => void) => void;
  'room:leave': (ack: (res: Ack) => void) => void;
  'room:ready': (ready: boolean, ack: (res: Ack) => void) => void;
  'game:play': (payload: GamePlayPayload, ack: (res: Ack) => void) => void;
  'game:pass': (ack: (res: Ack) => void) => void;
  'game:switchGive': (payload: SwitchGivePayload, ack: (res: Ack) => void) => void;
  // Inter-hand pause: a player taps "Continue" on the standings screen. When ALL
  // connected human players have done so the next hand deals early (else it auto-
  // deals after a short pause). Fire-and-forget (idempotent server-side).
  'game:continue': () => void;
  // Ranked matchmaking: join/leave a skill-matched queue for a match type.
  'ranked:queue:join': (payload: { matchType: MatchType }, ack: (res: Ack) => void) => void;
  'ranked:queue:leave': (ack: (res: Ack) => void) => void;
  // Practice vs bots: spin up a private zero-stake room filled with AI opponents.
  'practice:start': (payload: { type: MatchType; tier?: 'easy' | 'medium' | 'hard' }, ack: (res: Ack) => void) => void;
  // Spectating: watch a live match (broadcast-safe public state only — no hands).
  'room:spectate': (payload: { roomId: string }, ack: (res: Ack) => void) => void;
  'room:unspectate': (ack: (res: Ack) => void) => void;
  // Provably-fair: a client contributes a clientSeed (mixed into the shuffle).
  'fair:clientSeed': (seed: string) => void;
  // Social (§2.5): in-room emotes / preset quick-chat, and friend room invites.
  'emote': (emote: string) => void;
  'chat': (text: string) => void;
  'room:invite': (payload: { friendUserId: string }, ack: (res: Ack) => void) => void;
  // Club chat (§9 social): send a message to your club's channel (membership-gated,
  // rate-limited, mute-aware server-side). clubId is derived from membership, never
  // client-supplied.
  'club:message': (payload: { text: string }, ack: (res: Ack) => void) => void;
}

// ---------- Server -> Client -------------------------------------------------

export interface ServerToClientEvents {
  'lobby:state': (state: LobbyStateDTO) => void;
  'room:state': (state: RoomStateDTO) => void;
  'match:start': (room: RoomStateDTO) => void;
  'game:start': (dto: GameStartDTO) => void;          // private: your hand + counts
  'game:hand': (dto: HandDTO) => void;                // private: refreshed hand
  'game:state': (state: PublicGameStateDTO) => void;  // public broadcast
  'game:yourTurn': (state: PublicGameStateDTO) => void;
  'game:trickWon': (dto: TrickWonDTO) => void;
  'game:playerFinished': (dto: PlayerFinishedDTO) => void;
  'game:end': (dto: GameEndDTO) => void;
  'card:switch': (dto: CardSwitchDTO) => void;
  // The previous loser was dealt BOTH jokers → the card switch is skipped and the
  // winner leads. Clients show a "no swap" banner.
  'match:noSwap': (dto: { winner: Seat; loser: Seat }) => void;
  // Inter-hand pause progress: which seats have tapped Continue + how many humans
  // we're waiting on (for the "3/4 ready" indicator on the standings screen).
  'hand:continueState': (dto: { ready: Seat[]; humans: number }) => void;
  'match:scoreboard': (dto: ScoreboardDTO) => void;
  'match:end': (dto: MatchEndDTO) => void;
  'ranked:queue:update': (dto: RankedQueueDTO) => void; // matchmaking status while waiting
  'fair:commit': (dto: FairCommitDTO) => void;  // before the match
  'fair:reveal': (dto: FairRevealDTO) => void;  // after the match (verifiable)
  'error': (err: ErrorDTO) => void;
  // Social (§2.5)
  'emote': (dto: { seat: Seat; emote: string }) => void;
  'chat': (dto: { seat: Seat; username: string; text: string }) => void;
  'invited': (dto: { roomId: string; fromUsername: string; type: MatchType; stakeCents: number }) => void;
  'friend:request': (dto: { fromUsername: string }) => void; // someone sent you a friend request
  'club:chat': (dto: ChatMessageDTO) => void; // a new message in your club channel
}

// Optional typed inter-server / socket-data shapes (used by Socket.IO generics).
export interface InterServerEvents {
  ping: () => void;
}
export interface SocketData {
  userId: string;
  username: string;
  roomId: string | null;
  seat: Seat | null;
  clientSeed: string | null; // provably-fair contribution, if the client sent one
  spectating: string | null; // roomId being watched (not seated), if any
}

// ---------- Event name unions (handy for logging / tests) --------------------

export type ClientEventName = keyof ClientToServerEvents;
export type ServerEventName = keyof ServerToClientEvents;
