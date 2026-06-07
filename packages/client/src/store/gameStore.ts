import { create } from 'zustand';
import type { Card } from '@murlan/engine';
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

  lobby: LobbyRoomInfo[];
  live: LiveMatchInfo[]; // in-match rooms available to spectate
  room: RoomStateDTO | null;
  game: PublicGameStateDTO | null;
  gameIndex: number;
  mySeat: number | null;
  myHand: Card[];
  selected: string[];
  scoreboard: ScoreboardDTO | null;
  switchPrompt: SwitchPrompt | null;
  /** A card switch is in progress (between games) — true on every client until
   *  the next game starts, so non-winners show "opponent is choosing" instead of
   *  the shuffle splash. */
  switchPending: boolean;
  matchResult: MatchEndDTO | null;
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
}

function appendLog(prev: LogEntry[], text: string): LogEntry[] {
  return [...prev.slice(-29), { id: (logSeq += 1), text }];
}

const emptyRoomState = {
  room: null,
  game: null,
  gameIndex: 0,
  mySeat: null,
  myHand: [] as Card[],
  selected: [] as string[],
  scoreboard: null,
  switchPrompt: null,
  switchPending: false,
  matchResult: null,
  fairCommit: null,
  fairReveal: null,
  bubbles: [] as Bubble[],
  clubChat: [] as ChatMessageDTO[],
};

export const useGameStore = create<GameStore>((set, get) => ({
  socket: null,
  connected: false,
  myUserId: null,
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

    socket.on('match:start', (room) => {
      set((s) => ({ room, queue: null, log: appendLog(s.log, tg('log.matchStarted')) }));
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
        log: appendLog(s.log, tg('log.gameStarted', { n: dto.gameIndex + 1 })),
      }));
    });

    socket.on('game:hand', (dto) => set({ myHand: dto.hand, mySeat: dto.yourSeat }));

    socket.on('game:state', (state) => set({ game: state }));
    socket.on('game:yourTurn', (state) => set({ game: state }));

    socket.on('game:trickWon', (dto) =>
      set((s) => ({ log: appendLog(s.log, tg('log.trickWon', { seat: dto.winner + 1 })) })),
    );
    socket.on('game:playerFinished', (dto) =>
      set((s) => ({ log: appendLog(s.log, tg('log.playerFinished', { seat: dto.seat + 1, place: dto.place })) })),
    );
    socket.on('game:end', (dto) =>
      // Clear the public game so the felt resets and the shuffle splash shows
      // again before the next game's deal.
      set((s) => ({ game: null, scoreboard: dto.scoreboard, log: appendLog(s.log, tg('log.gameEnded')) })),
    );

    socket.on('card:switch', (dto) => {
      const mySeat = get().mySeat;
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

    socket.on('fair:commit', (dto) => {
      // Contribute fresh entropy AFTER the commitment — this is what makes the
      // deal un-grindable (the server fixed serverSeed before seeing this seed).
      socket.emit('fair:clientSeed', randomSeed());
      set((s) => ({ fairCommit: dto, fairReveal: null, log: appendLog(s.log, tg('log.fairCommit')) }));
    });
    socket.on('fair:reveal', (dto) =>
      set((s) => ({ fairReveal: dto, log: appendLog(s.log, tg('log.fairReveal')) })),
    );

    socket.on('match:scoreboard', (sb) => set({ scoreboard: sb }));

    socket.on('match:end', (dto) => {
      const won = dto.winnerSeats.includes(get().mySeat ?? -1);
      useNotifications.getState().push(won ? tg('msg.matchWon') : tg('msg.matchEnded'), won ? 'win' : 'info');
      set((s) => ({
        matchResult: dto,
        scoreboard: dto.scoreboard,
        game: null, // stop the turn timer & clear the board behind the result overlay
        switchPrompt: null,
        switchPending: false,
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

  // "Luaj sërish": from a finished match, open a FRESH room of the same type/stake
  // (and my same team in 2v2) and land in it waiting for opponents. The prior
  // match is fully settled — this is its own room/escrow, never a continuation.
  // One-room-per-user means we must leave the finished room first.
  async rematch() {
    const { room, mySeat } = get();
    if (!room) return;
    const type = room.type;
    const stakeCents = room.stakeCents;
    const team = type === '2v2' && mySeat !== null ? room.seats[mySeat]?.team ?? undefined : undefined;
    get().dismissResult();
    await get().leaveRoom();
    await get().createRoom(type, stakeCents, team ?? undefined);
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
