import { create } from 'zustand';
import type { Card, Combo } from '@murlan/engine';
import { cardId } from '@murlan/engine';
import type {
  LobbyRoomInfo, LiveMatchInfo, LobbyStateDTO, RoomStateDTO, PublicGameStateDTO, ScoreboardDTO, MatchEndDTO, MatchType,
  FairCommitDTO, FairRevealDTO, ChatMessageDTO,
} from '@murlan/shared';
import { PLAYERS_PER_TYPE } from '@murlan/shared';
import { connectSocket, request, type MurlanSocket } from '../lib/socket.ts';
import { refreshAccessToken } from '../lib/api.ts';
import { ackText } from '../lib/errors.ts';
import { translate, useLangStore, type TVars } from '../lib/i18n.ts';
import { toggleCard, selectedCards } from '../lib/selection.ts';
import { useNotifications } from './notificationsStore.ts';

// Localized toast text for store actions (outside React render → read live lang).
const tg = (key: string, vars?: TVars) => translate(key, useLangStore.getState().lang, vars);

export interface LogEntry {
  id: number;
  text: string;
}

export interface SwitchPrompt {
  winner: number;
  loser: number;
}

/** Inter-hand standings: shown after a hand ends (the final board stays frozen behind
 *  it) until the next hand deals. `finishingOrder[0]` is the hand winner. */
export interface HandStandings {
  finishingOrder: number[];
  scoreboard: ScoreboardDTO;
  gameIndex: number;
}

/** A transient emote/chat bubble shown above a seat (auto-expires). */
export interface Bubble {
  id: number;
  seat: number;
  kind: 'emote' | 'chat';
  text: string;
  username?: string;
}

/** Visual tone for the global toast banner (errors look red, successes green). */
export type ToastKind = 'error' | 'success' | 'info';

/** An incoming room invite from a friend. */
export interface Invite {
  roomId: string;
  fromUsername: string;
  type: MatchType;
  stakeCents: number;
}

interface Ack {
  ok: boolean;
  error?: { code: string; message: string };
  roomId?: string;
}

let logSeq = 0;
let bubbleSeq = 0;

/** A random client seed contributed to the provably-fair shuffle. */
function randomSeed(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface GameStore {
  socket: MurlanSocket | null;
  connected: boolean;
  myUserId: string | null;
  socialRev: number; // bumps on a friend:request / social:refresh → the Friends page reloads
  rewardRev: number; // bumps on reward:refresh (a finished match changed my stats) → Challenges reloads
  lbRev: number;     // bumps on leaderboard:refresh (any finished match) → an open Leaderboard reloads

  lobby: LobbyRoomInfo[];
  live: LiveMatchInfo[]; // in-match rooms available to spectate
  room: RoomStateDTO | null;
  /** Live count of people watching this room (0 = none). Drives the table's watcher badge. */
  spectators: number;
  game: PublicGameStateDTO | null;
  /** Client-only visual stack of the plays already beaten in the CURRENT trick. The server
   *  pile is a single combo (the one to beat); we keep the earlier plays so they stay on the
   *  felt with newer plays overlaid on top. Cleared on trick win and on a new hand. */
  pileHistory: Combo[];
  gameIndex: number;
  mySeat: number | null;
  myHand: Card[];
  selected: string[];
  scoreboard: ScoreboardDTO | null;
  /** Set when a hand ends → drives the inter-hand standings overlay; cleared when the
   *  next hand deals (game:start) or the match ends. */
  handStandings: HandStandings | null;
  /** Seats that have tapped "Continue" on the standings screen + how many humans we wait
   *  on (for the "X/N ready" indicator). */
  handReady: number[];
  handHumans: number;
  switchPrompt: SwitchPrompt | null;
  /** A card switch is in progress (between games) — true on every client until
   *  the next game starts, so non-winners show "opponent is choosing" instead of
   *  the shuffle splash. */
  switchPending: boolean;
  /** Transient: the previous loser held both jokers → no card switch this game and
   *  the winner leads. Drives the "no swap" banner; auto-clears after a few seconds. */
  noSwapNotice: boolean;
  /** The two cards exchanged in the current switch (only revealed to the winner +
   *  loser), shown on the table. Cleared shortly after the switch completes. */
  switchCards: { given: Card | null; returned: Card | null } | null;
  matchResult: MatchEndDTO | null;
  /** Open rematch offer for the just-finished room: who has opted in + the window
   *  deadline (epoch ms). null when no offer is open. Drives the "2/3 want a rematch"
   *  state on the match-over screen. */
  rematchOffer: { accepted: string[]; deadline: number } | null;
  fairCommit: FairCommitDTO | null;
  fairReveal: FairRevealDTO | null;
  log: LogEntry[];
  toast: string | null;
  toastKind: ToastKind;
  bubbles: Bubble[];
  /** Club chat messages (history seed + live appends). */
  clubChat: ChatMessageDTO[];
  invite: Invite | null;
  /** Ranked matchmaking status while waiting (null = not queued). */
  queue: { matchType: MatchType; size: number; needed: number } | null;
  /** True while watching a live match as a spectator (read-only, not seated). */
  spectating: boolean;

  connect: (getToken: () => string | null, userId: string) => void;
  disconnect: () => void;
  refreshLobby: () => void;
  createRoom: (type: MatchType, stakeCents: number, team?: 0 | 1, priv?: boolean) => Promise<string | null>;
  joinRoom: (roomId: string, team?: 0 | 1) => Promise<boolean>;
  joinByCode: (code: string) => Promise<boolean>;
  rematch: () => Promise<void>;
  leaveRoom: () => Promise<void>;
  setReady: (ready: boolean) => Promise<void>;
  toggleCardSel: (id: string) => void;
  clearSelection: () => void;
  play: () => Promise<void>;
  pass: () => Promise<void>;
  giveSwitch: (card: Card) => Promise<void>;
  /** Tap "Continue" on the inter-hand standings screen (advances early once all do). */
  continueHand: () => void;
  dismissToast: () => void;
  dismissResult: () => void;
  sendEmote: (emote: string) => void;
  sendChat: (text: string) => void;
  inviteFriend: (friendUserId: string) => Promise<boolean>;
  /** Club chat: seed history (REST) + send a message (socket). */
  setClubChat: (messages: ChatMessageDTO[]) => void;
  sendClubMessage: (text: string) => Promise<boolean>;
  acceptInvite: () => Promise<void>;
  dismissInvite: () => void;
  findRanked: (matchType: MatchType) => Promise<boolean>;
  cancelRanked: () => void;
  /** Start a private zero-stake match vs AI bots. */
  startPractice: (type: MatchType, tier?: 'easy' | 'medium' | 'hard') => Promise<boolean>;
  spectate: (roomId: string) => Promise<boolean>;
  stopSpectate: () => void;
  /** Join/leave the leaderboard live-refresh channel (call while the page is open). */
  watchLeaderboard: () => void;
  unwatchLeaderboard: () => void;
}

function appendLog(prev: LogEntry[], text: string): LogEntry[] {
  return [...prev.slice(-29), { id: (logSeq += 1), text }];
}

/** Signature of a combo by its exact cards — identifies a distinct play within a trick. */
const comboSig = (c: Combo) => c.cards.map(cardId).join(',');
/** Maintain the visual pile stack as the authoritative single-combo pile changes:
 *  - pile cleared (trick won / between)  → empty the felt
 *  - first lead of a trick (no old pile) → nothing to stack under, keep history
 *  - a new combo beat the old one        → push the old combo under the new (capped)
 *  - same pile re-sent (state refresh)   → unchanged */
function nextPileHistory(hist: Combo[], oldPile: Combo | null, newPile: Combo | null): Combo[] {
  if (!newPile) return [];
  if (!oldPile) return hist;
  if (comboSig(oldPile) === comboSig(newPile)) return hist;
  return [...hist, oldPile].slice(-10);
}

const emptyRoomState = {
  room: null,
  spectators: 0,
  game: null,
  pileHistory: [] as Combo[],
  gameIndex: 0,
  mySeat: null,
  myHand: [] as Card[],
  selected: [] as string[],
  scoreboard: null,
  handStandings: null,
  handReady: [] as number[],
  handHumans: 0,
  switchPrompt: null,
  switchPending: false,
  noSwapNotice: false,
  switchCards: null,
  matchResult: null,
  rematchOffer: null,
  fairCommit: null,
  fairReveal: null,
  bubbles: [] as Bubble[],
  clubChat: [] as ChatMessageDTO[],
};

export const useGameStore = create<GameStore>((set, get) => ({
  socket: null,
  connected: false,
  myUserId: null,
  socialRev: 0,
  rewardRev: 0,
  lbRev: 0,
  lobby: [],
  live: [],
  ...emptyRoomState,
  log: [],
  toast: null,
  toastKind: 'error',
  invite: null,
  queue: null,
  spectating: false,

  connect(getToken, userId) {
    if (get().socket) return; // already connected
    const socket = connectSocket(getToken);
    set({ socket, myUserId: userId });

    socket.on('connect', () => {
      set({ connected: true });
      get().refreshLobby();
    });
    socket.on('disconnect', () => set({ connected: false }));
    // A rejected handshake (expired access token) surfaces as connect_error.
    // Refresh the token now so Socket.IO's next auto-reconnect attempt — which
    // re-invokes the auth callback — carries a live token instead of looping.
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') void refreshAccessToken().catch(() => {});
    });

    socket.on('lobby:state', (state) => set({ lobby: state.rooms, live: state.live }));

    socket.on('room:state', (state) => {
      const seat = state.seats.findIndex((s) => s.userId === get().myUserId);
      set({ room: state, mySeat: seat >= 0 ? seat : get().mySeat, queue: null });
    });

    socket.on('room:spectators', (dto) => set({ spectators: dto.count }));

    socket.on('match:start', (room) => {
      // A (re)match is starting → clear the previous match-over overlay + any rematch offer.
      set((s) => ({ room, queue: null, matchResult: null, rematchOffer: null, log: appendLog(s.log, tg('log.matchStarted')) }));
    });

    // Rematch offer state for the just-finished room ("2/3 want a rematch").
    socket.on('rematch:offer', (dto) => set({ rematchOffer: { accepted: dto.accepted, deadline: dto.deadline } }));
    socket.on('rematch:cancelled', () => {
      if (get().rematchOffer) useNotifications.getState().push(tg('rematch.cancelled'), 'info');
      set({ rematchOffer: null });
    });

    // Ranked matchmaking status while waiting (cleared once we're seated/matched).
    socket.on('ranked:queue:update', (dto) => {
      set({ queue: dto.inQueue && dto.matchType ? { matchType: dto.matchType, size: dto.size, needed: dto.needed } : null });
    });

    socket.on('game:start', (dto) => {
      set((s) => ({
        myHand: dto.hand,
        mySeat: dto.yourSeat,
        game: dto.state,
        gameIndex: dto.gameIndex,
        selected: [],
        switchPrompt: null,
        switchPending: false,
        handStandings: null, // the next hand dealt → drop the standings overlay
        handReady: [],
        handHumans: 0,
        pileHistory: [], // fresh hand → clear the felt stack
        log: appendLog(s.log, tg('log.gameStarted', { n: dto.gameIndex + 1 })),
      }));
    });

    socket.on('game:hand', (dto) => set({ myHand: dto.hand, mySeat: dto.yourSeat }));

    socket.on('game:state', (state) =>
      set((s) => ({ pileHistory: nextPileHistory(s.pileHistory, s.game?.pile ?? null, state.pile ?? null), game: state })),
    );
    socket.on('game:yourTurn', (state) =>
      set((s) => ({ pileHistory: nextPileHistory(s.pileHistory, s.game?.pile ?? null, state.pile ?? null), game: state })),
    );

    socket.on('game:trickWon', (dto) =>
      // Trick over → the next game:state will null the pile; clear the felt stack now too.
      set((s) => ({ pileHistory: [], log: appendLog(s.log, tg('log.trickWon', { seat: dto.winner + 1 })) })),
    );
    socket.on('game:playerFinished', (dto) =>
      set((s) => ({ log: appendLog(s.log, tg('log.playerFinished', { seat: dto.seat + 1, place: dto.place })) })),
    );
    socket.on('game:end', (dto) =>
      // KEEP the public game so the final board (the winning play) stays VISIBLE during
      // the inter-hand pause — instead of instantly clearing to the shuffle splash. The
      // standings overlay renders on top until the next hand deals (game:start). match:end
      // (final hand) clears it right after, so the match-end overlay shows instead.
      set((s) => ({
        scoreboard: dto.scoreboard,
        handStandings: { finishingOrder: dto.finishingOrder, scoreboard: dto.scoreboard, gameIndex: dto.gameIndex },
        handReady: [],
        handHumans: 0,
        log: appendLog(s.log, tg('log.gameEnded')),
      })),
    );

    socket.on('card:switch', (dto) => {
      const mySeat = get().mySeat;
      // The card switch belongs to the NEXT hand: once it begins (after everyone taps
      // Continue), the standings screen is obsolete. game:start clears it for the other
      // switch paths; this covers the common "winner returns a card" path, which deals
      // via game:hand/card:switch instead of game:start.
      if (get().handStandings) set({ handStandings: null, pileHistory: [] });
      // Track the exchanged cards (revealed only to the winner+loser) so both can
      // be shown on the table. `given` arrives first (loser→winner), `returned` next.
      if (dto.given || dto.returned) {
        set((s) => {
          const base = dto.given ? { given: dto.given, returned: null } : (s.switchCards ?? { given: null, returned: null });
          return { switchCards: { given: dto.given ?? base.given, returned: dto.returned ?? base.returned } };
        });
        // Once the return lands, keep the reveal on screen briefly, then clear it.
        if (dto.returned) setTimeout(() => set({ switchCards: null }), 2600);
      }
      if (dto.awaitingReturn && dto.given === null && dto.winner === mySeat) {
        // I am the winner: choose a 3–10 card to return to the loser.
        set({ switchPrompt: { winner: dto.winner, loser: dto.loser }, switchPending: true });
        return;
      }
      set((s) => {
        const next = { ...s };
        if (dto.given) next.log = appendLog(s.log, tg('log.switchGiven', { loser: dto.loser + 1, winner: dto.winner + 1 }));
        if (dto.returned) next.log = appendLog(next.log, tg('log.switchReturned', { winner: dto.winner + 1, loser: dto.loser + 1 }));
        // awaitingReturn = the switch is still in progress (any client); when the
        // return lands (awaitingReturn=false) it is done — clear the pending flag.
        next.switchPending = dto.awaitingReturn;
        if (!dto.awaitingReturn && dto.winner === s.mySeat) next.switchPrompt = null;
        return next;
      });
    });

    socket.on('match:noSwap', (dto) => {
      // Loser held both jokers → no switch this game, winner leads. Flash a banner.
      set((s) => ({ noSwapNotice: true, log: appendLog(s.log, tg('log.noSwap', { loser: dto.loser + 1, winner: dto.winner + 1 })) }));
      setTimeout(() => set({ noSwapNotice: false }), 4000);
    });

    socket.on('match:playerLeft', (dto) => {
      // A player abandoned but the match CONTINUES (they're auto-passed, placed last,
      // and forfeit their stake). Survivors get a notice; the seat shows greyed via
      // the public game state (`gone`). The match ends normally only when too few remain.
      const mine = dto.seat === get().mySeat;
      const name = dto.username ?? tg('common.aPlayer');
      const idle = dto.reason === 'idle'; // removed for not playing 3 turns in a row
      set((s) => ({
        toast: mine
          ? (idle ? tg('msg.youIdleRemoved') : tg('msg.youLeftMatch'))
          : (idle ? tg('msg.playerIdleRemoved', { name }) : tg('msg.playerLeftContinues', { name })),
        toastKind: 'info',
        log: appendLog(s.log, tg(idle ? 'log.playerIdleRemoved' : 'log.playerLeft', { name })),
      }));
    });

    socket.on('fair:commit', (dto) => {
      // Contribute fresh entropy AFTER the commitment — this is what makes the
      // deal un-grindable (the server fixed serverSeed before seeing this seed).
      socket.emit('fair:clientSeed', randomSeed());
      set((s) => ({ fairCommit: dto, fairReveal: null, log: appendLog(s.log, tg('log.fairCommit')) }));
    });
    socket.on('fair:reveal', (dto) =>
      set((s) => ({ fairReveal: dto, log: appendLog(s.log, tg('log.fairReveal')) })),
    );

    // Inter-hand pause progress: who has tapped Continue + how many humans we wait on.
    socket.on('hand:continueState', (dto) => set({ handReady: dto.ready, handHumans: dto.humans }));

    socket.on('match:scoreboard', (sb) => set({ scoreboard: sb }));

    socket.on('match:end', (dto) => {
      const won = dto.winnerSeats.includes(get().mySeat ?? -1);
      useNotifications.getState().push(won ? tg('msg.matchWon') : tg('msg.matchEnded'), won ? 'win' : 'info');
      set((s) => ({
        matchResult: dto,
        scoreboard: dto.scoreboard,
        game: null, // stop the turn timer & clear the board behind the result overlay
        handStandings: null, // the match-end overlay supersedes the inter-hand standings
        handReady: [],
        switchPrompt: null,
        switchPending: false,
        noSwapNotice: false,
        switchCards: null,
        log: appendLog(s.log, tg('log.matchEnded')),
      }));
    });

    socket.on('error', (err) => set({ toast: ackText(err, 'err.generic'), toastKind: 'error' }));

    // Social (§2.5): incoming emotes / quick-chat → transient bubbles; invites.
    socket.on('emote', ({ seat, emote }) => {
      const id = (bubbleSeq += 1);
      set((s) => ({ bubbles: [...s.bubbles, { id, seat, kind: 'emote', text: emote }] }));
      setTimeout(() => set((s) => ({ bubbles: s.bubbles.filter((b) => b.id !== id) })), 3500);
    });
    socket.on('chat', ({ seat, username, text }) => {
      const id = (bubbleSeq += 1);
      set((s) => ({ bubbles: [...s.bubbles, { id, seat, kind: 'chat', text, username }] }));
      setTimeout(() => set((s) => ({ bubbles: s.bubbles.filter((b) => b.id !== id) })), 4500);
    });
    socket.on('invited', (dto) => {
      useNotifications.getState().push(`📨 ${tg('msg.invitedToGame', { name: dto.fromUsername })}`, 'invite');
      set({ invite: dto, toast: tg('msg.invitedToGame', { name: dto.fromUsername }), toastKind: 'info' });
    });
    socket.on('tournament:matchReady', (dto) => {
      // The bracket paired us — auto-join our tournament match (the gateway gated the
      // room to us; the match plays + advances the bracket automatically).
      set({ toast: tg('msg.tournamentMatchReady'), toastKind: 'info' });
      void get().joinRoom(dto.roomId);
    });
    socket.on('friend:request', (dto) => {
      useNotifications.getState().push(`👥 ${tg('msg.friendRequestFrom', { name: dto.fromUsername })}`, 'invite');
      set((s) => ({ socialRev: s.socialRev + 1 })); // refresh an open Friends page instantly
    });
    // A friends-list change concerning me (my request was answered / I was unfriended).
    socket.on('social:refresh', () => set((s) => ({ socialRev: s.socialRev + 1 })));
    // A finished match changed my stats → refresh an open Challenges/Rewards page.
    socket.on('reward:refresh', () => set((s) => ({ rewardRev: s.rewardRev + 1 })));
    // A finished match (anyone's) may have moved ranks → refresh an open Leaderboard.
    socket.on('leaderboard:refresh', () => set((s) => ({ lbRev: s.lbRev + 1 })));
    socket.on('club:chat', (dto) => {
      // Append live; dedup by id (the sender also receives their own message).
      set((s) => (s.clubChat.some((m) => m.id === dto.id) ? s : { clubChat: [...s.clubChat, dto].slice(-100) }));
    });
  },

  disconnect() {
    get().socket?.close();
    set({ socket: null, connected: false, lobby: [], live: [], log: [], toast: null, toastKind: 'error', invite: null, queue: null, spectating: false, ...emptyRoomState });
  },

  refreshLobby() {
    const socket = get().socket;
    if (!socket) return;
    void request<LobbyStateDTO>(socket, 'lobby:list').then((state) => set({ lobby: state?.rooms ?? [], live: state?.live ?? [] }));
  },

  async createRoom(type, stakeCents, team, priv) {
    const socket = get().socket;
    if (!socket) return null;
    const res = await request<Ack>(socket, 'room:create', { type, stakeCents, team, private: priv });
    if (!res.ok) {
      set({ toast: ackText(res.error, 'err.createRoomFailed'), toastKind: 'error' });
      return null;
    }
    return res.roomId ?? null;
  },

  async joinRoom(roomId, team) {
    const socket = get().socket;
    if (!socket) return false;
    const res = await request<Ack>(socket, 'room:join', { roomId, team });
    if (!res.ok) set({ toast: ackText(res.error, 'err.joinRoomFailed'), toastKind: 'error' });
    return res.ok;
  },

  async joinByCode(code) {
    const socket = get().socket;
    if (!socket) return false;
    const res = await request<Ack>(socket, 'room:joinByCode', { code: code.trim().toUpperCase() });
    if (!res.ok) set({ toast: ackText(res.error, 'err.joinRoomFailed'), toastKind: 'error' });
    return res.ok;
  },

  // "Luaj sërish": opt into a rematch of the SAME finished room — same opponents,
  // seats/teams and stake. We STAY in the room; when every present player opts in
  // (within the ~20s window) the server resets it and a new match deals (fresh matchId +
  // re-escrow). rematch:offer drives the "2/3" progress; match:start clears the overlay.
  // Ranked/tournament rooms are rejected server-side with a clear message.
  async rematch() {
    const socket = get().socket;
    if (!socket || !get().room) return;
    const res = await request<Ack>(socket, 'room:rematch');
    if (!res.ok) set({ toast: ackText(res.error, 'rematch.unavailable'), toastKind: 'error' });
    // On success we stay put; the offer + match:start events take over.
  },

  async startPractice(type, tier) {
    const socket = get().socket;
    if (!socket) return false;
    const res = await request<Ack>(socket, 'practice:start', { type, tier });
    if (!res.ok) set({ toast: ackText(res.error, 'err.practiceStartFailed'), toastKind: 'error' });
    return res.ok;
  },

  async findRanked(matchType) {
    const socket = get().socket;
    if (!socket) return false;
    const res = await request<Ack>(socket, 'ranked:queue:join', { matchType });
    if (!res.ok) {
      set({ toast: ackText(res.error, 'err.queueJoinFailed'), toastKind: 'error' });
      return false;
    }
    // Optimistic searching state (the server confirms/updates via ranked:queue:update).
    set((s) => ({ queue: s.queue ?? { matchType, size: 1, needed: PLAYERS_PER_TYPE[matchType] } }));
    return true;
  },

  cancelRanked() {
    const socket = get().socket;
    set({ queue: null });
    if (socket) void request<Ack>(socket, 'ranked:queue:leave');
  },

  async spectate(roomId) {
    const socket = get().socket;
    if (!socket) return false;
    const res = await request<Ack>(socket, 'room:spectate', { roomId });
    if (!res.ok) {
      set({ toast: ackText(res.error, 'err.spectateFailed'), toastKind: 'error' });
      return false;
    }
    // The server pushes room:state + game:state + scoreboard, which populate the
    // store; this flag routes the app to the read-only spectator view.
    set({ spectating: true, queue: null });
    return true;
  },

  stopSpectate() {
    const socket = get().socket;
    if (socket) void request<Ack>(socket, 'room:unspectate');
    set({ ...emptyRoomState, spectating: false });
    get().refreshLobby();
  },

  async leaveRoom() {
    const socket = get().socket;
    if (!socket) return;
    await request<Ack>(socket, 'room:leave');
    set({ ...emptyRoomState });
    get().refreshLobby();
  },

  async setReady(ready) {
    const socket = get().socket;
    if (!socket) return;
    const res = await request<Ack>(socket, 'room:ready', ready);
    if (!res.ok) set({ toast: ackText(res.error, 'err.actionFailed'), toastKind: 'error' });
  },

  toggleCardSel(id) {
    set((s) => ({ selected: toggleCard(s.selected, id) }));
  },
  clearSelection() {
    set({ selected: [] });
  },

  async play() {
    const { socket, myHand, selected } = get();
    if (!socket || selected.length === 0) return;
    const cards = selectedCards(myHand, selected);
    const res = await request<Ack>(socket, 'game:play', { cards });
    if (res.ok) {
      // Read CURRENT state in the updater: an authoritative game:start/game:hand
      // may have landed between the emit and this ack.
      const chosen = new Set(selected);
      set((s) => ({ myHand: s.myHand.filter((c) => !chosen.has(cardId(c))), selected: [] }));
    } else {
      set({ toast: ackText(res.error, 'err.illegalMove'), toastKind: 'error' });
    }
  },

  async pass() {
    const socket = get().socket;
    if (!socket) return;
    const res = await request<Ack>(socket, 'game:pass');
    if (!res.ok) set({ toast: ackText(res.error, 'err.cannotPassNow'), toastKind: 'error' });
  },

  async giveSwitch(card) {
    const socket = get().socket;
    if (!socket) return;
    const res = await request<Ack>(socket, 'game:switchGive', { card });
    if (res.ok) {
      // Don't mutate the hand here. The authoritative `game:start` for the next game
      // (with the 2-card swap already applied + re-sorted) sets the correct hand a
      // moment later. Mutating optimistically flashed a half-updated, mis-ordered
      // hand for that moment — which is the glitch players saw. Just close the prompt.
      set({ switchPrompt: null, switchPending: false });
    } else {
      set({ toast: ackText(res.error, 'err.cardSwitchFailed'), toastKind: 'error' });
    }
  },

  continueHand() {
    const { socket, mySeat, handReady } = get();
    if (!socket) return;
    socket.emit('game:continue'); // fire-and-forget; the server echoes hand:continueState
    // Optimistic: mark my own seat ready immediately so the button flips to "waiting…"
    // without a round-trip (the server echo reconciles).
    if (mySeat != null && !handReady.includes(mySeat)) set({ handReady: [...handReady, mySeat] });
  },

  dismissToast() {
    set({ toast: null, toastKind: 'error' });
  },
  dismissResult() {
    set({ matchResult: null });
  },

  // ----- Social (§2.5) — additive socket glue, no game/money logic ----------
  sendEmote(emote) {
    get().socket?.emit('emote', emote);
  },
  sendChat(text) {
    const t = text.trim().slice(0, 80);
    if (t) get().socket?.emit('chat', t);
  },
  setClubChat(messages) {
    set({ clubChat: messages });
  },
  async sendClubMessage(text) {
    const socket = get().socket;
    const t = text.trim();
    if (!socket || !t) return false;
    const res = await request<Ack>(socket, 'club:message', { text: t });
    if (!res.ok) set({ toast: ackText(res.error, 'err.messageFailed'), toastKind: 'error' });
    return res.ok;
  },
  async inviteFriend(friendUserId) {
    const socket = get().socket;
    if (!socket) return false;
    const res = await request<Ack>(socket, 'room:invite', { friendUserId });
    if (res.ok) set({ toast: tg('msg.inviteSent'), toastKind: 'success' });
    else set({ toast: ackText(res.error, 'err.inviteFailed'), toastKind: 'error' });
    return res.ok;
  },
  watchLeaderboard() {
    get().socket?.emit('leaderboard:watch'); // idempotent; no-op if not connected yet
  },
  unwatchLeaderboard() {
    get().socket?.emit('leaderboard:unwatch');
  },
  async acceptInvite() {
    const inv = get().invite;
    if (!inv) return;
    set({ invite: null });
    await get().joinRoom(inv.roomId);
  },
  dismissInvite() {
    set({ invite: null });
  },
}));
