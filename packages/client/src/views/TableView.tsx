import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { RoomStateDTO } from '@murlan/shared';
import type { Card } from '@murlan/engine';
import { PLAYERS_PER_TYPE, isReturnEligible } from '@murlan/shared';
import { useGameStore, type Bubble } from '../store/gameStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { selectedCards } from '../lib/selection.ts';
import { cardKey, cardLabel } from '../lib/cards.ts';
import { seatPosition, type SeatPosition } from '../lib/layout.ts';
import { sound } from '../lib/sound.ts';
import { haptics } from '../lib/haptics.ts';
import { useWakeLock } from '../lib/useWakeLock.ts';
import { dollars } from '../lib/money.ts';
import { wentOutSeat } from '../lib/finish.ts';
import { Hand } from '../components/Hand.tsx';
import { PlayLog } from '../components/PlayLog.tsx';
import { Pile } from '../components/Pile.tsx';
import { CardView } from '../components/CardView.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { Controls } from '../components/Controls.tsx';
import { TurnTimer } from '../components/TurnTimer.tsx';
import { useForceLandscape } from '../lib/useForceLandscape.ts';
import { RotateOverlay } from '../components/ui/RotateOverlay.tsx';
import { Confetti } from '../components/ui/Confetti.tsx';
import { CountUp } from '../components/ui/CountUp.tsx';
import { EmoteChat } from '../components/EmoteChat.tsx';
import { ProfileModal } from '../components/ui/ProfileModal.tsx';
import { useFocusTrap } from '../components/ui/useFocusTrap.ts';
import { useCosmeticsStore } from '../store/cosmeticsStore.ts';
import { friendsApi, ApiError } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';

/** Where each opponent seat sits around the oval rail (local player is bottom). */
const SEAT_POS: Record<SeatPosition, string> = {
  bottom: 'left-1/2 -translate-x-1/2 -bottom-7',
  top: 'left-1/2 -translate-x-1/2 -top-8 max-[480px]:-top-5',
  'top-left': 'left-4 -top-6 max-[480px]:left-1 max-[480px]:-top-4',
  'top-right': 'right-4 -top-6 max-[480px]:right-1 max-[480px]:-top-4',
  left: '-left-3 top-1/2 -translate-y-1/2 max-[480px]:left-1 max-[480px]:top-[36%]',
  right: '-right-3 top-1/2 -translate-y-1/2 max-[480px]:right-1 max-[480px]:top-[36%]',
};

/**
 * LANDSCAPE canvas coordinates. The whole table is ONE fixed-aspect (1280/590)
 * container; every slot is absolutely positioned by % of the container with
 * transform: translate(-50%,-50%) centering on the given (cx,cy). These are the
 * exact spec coordinates — the local player has no seat avatar (only the hand).
 * `seatPosition()` returns top / top-left / top-right / left / right; the 3-player
 * top-left/top-right pair maps onto the spec's left/right slots.
 */
const LS_SEAT_SLOT: Record<SeatPosition, 'top' | 'left' | 'right' | null> = {
  top: 'top',
  'top-left': 'left',
  'top-right': 'right',
  left: 'left',
  right: 'right',
  bottom: null, // local player — no avatar
};
/** center (cx,cy) of each opponent seat group, as % of the canvas. */
const LS_SEAT_CXY: Record<'top' | 'left' | 'right', { cx: number; cy: number }> = {
  top: { cx: 49, cy: 12 },
  left: { cx: 10, cy: 40 },   // pushed further LEFT (toward the edge) — more space from the cards
  right: { cx: 91, cy: 40 },  // pushed further RIGHT (toward the edge) — more space from the cards
};

/** A transient emote/quick-chat speech bubble above a seat. */
function SpeechBubble({ b }: { b: Bubble }) {
  return (
    <div className="absolute left-1/2 -translate-x-1/2 -top-9 z-20 animate-pop max-w-[150px] truncate rounded-xl px-2.5 py-1 panel-solid shadow-lg">
      {b.kind === 'emote' ? <span className="text-xl leading-none">{b.text}</span> : <span className="text-sm text-txt">{b.text}</span>}
    </div>
  );
}

/** In-game history panel (behind the ☰ button). Subscribes to `log` ITSELF so
 *  the frequent log appends only re-render this panel when it's open — never the
 *  whole table (which uses a log-free selector). */
function LogPanel({ onClose }: { onClose: () => void }) {
  const log = useGameStore((s) => s.log);
  const t = useT();
  const trapRef = useFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop !z-[58]" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('table.gameHistory')}>
      <div ref={trapRef} tabIndex={-1} className="panel-solid w-full max-w-sm p-5 animate-pop outline-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display font-semibold tracking-wide text-gold-hi text-sm">{t('table.history')}</h3>
          <button className="iconbtn" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          <PlayLog entries={log} />
        </div>
      </div>
    </div>
  );
}

// Visually-hidden live regions for screen-reader users (the felt is CSS transforms,
// not semantic structure). TWO channels (A11Y-4):
//  • ASSERTIVE (interrupts): "your turn" + the final result — the things a player must
//    act on / hear immediately.
//  • POLITE (queues): every table ACTION — each play/pass, new round, card-switch, score
//    — sourced from the running game log so a blind player can follow the whole hand.
// A trailing-space toggle makes an identical consecutive message ("…passed", "your turn")
// re-announce instead of being silently de-duped by the AT.
function GameAnnouncer({ isMyTurn, result }: { isMyTurn: boolean; result: string | null }) {
  const t = useT();
  const log = useGameStore((s) => s.log); // subscribe HERE so appends re-render only this, not the felt
  const [turnMsg, setTurnMsg] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  useEffect(() => {
    if (isMyTurn) setTurnMsg((m) => (m.trimEnd() === t('table.yourTurn') ? `${t('table.yourTurn')} ` : t('table.yourTurn')));
  }, [isMyTurn, t]);
  useEffect(() => { if (result) setTurnMsg(result); }, [result]); // result overrides the turn line

  useEffect(() => {
    const last = log[log.length - 1];
    if (last?.text) setActionMsg((m) => (m.trimEnd() === last.text ? `${last.text} ` : last.text));
  }, [log]);

  return (
    <>
      <div className="sr-only" role="status" aria-live="assertive">{turnMsg}</div>
      <div className="sr-only" role="log" aria-live="polite" aria-atomic="true">{actionMsg}</div>
    </>
  );
}

/** Fill-players (bots) are seated only on free/practice tables; the client receives their
 *  synthetic userId with this prefix, so we never offer to "friend" one. */
const BOT_USERID_PREFIX = 'bot:';

/**
 * Match-over: offer "Shto mik" (add friend) for each HUMAN opponent who isn't already a
 * friend. Best-effort — fires the existing friend-request API and toasts on success; a
 * row that's already a friend (or already requested) is hidden/disabled. Never blocks the
 * result screen and touches no game/money state.
 */
function AddFriendButtons({ room, mySeat }: { room: RoomStateDTO; mySeat: number | null }) {
  const t = useT();
  const myUserId = mySeat !== null ? room.seats[mySeat]?.userId ?? null : null;
  // Human opponents only: a real userId, not me, not a bot. A SPECTATOR (myUserId null) is not a
  // participant → offer nobody (otherwise the "not me" filter excludes no one and they'd get a
  // button for every seated player).
  const opponents = myUserId === null ? [] : room.seats.filter(
    (s) => s.userId && s.userId !== myUserId && s.username && !s.userId.startsWith(BOT_USERID_PREFIX),
  );
  // Per-userId button state: 'idle' | 'sending' | 'sent' | 'already' (already a friend / pending).
  const [state, setState] = useState<Record<string, 'idle' | 'sending' | 'sent' | 'already'>>({});

  // Pre-mark anyone already connected as a friend / with a pending request so we don't
  // offer a duplicate. Best-effort: on any failure we simply show the buttons.
  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token || opponents.length === 0) return;
    let alive = true;
    friendsApi.list(token)
      .then(({ friends }) => {
        if (!alive) return;
        const known = new Set(friends.map((f) => f.user.id)); // friends + pending + blocked → never re-offer
        setState((prev) => {
          const next = { ...prev };
          for (const o of opponents) if (o.userId && known.has(o.userId)) next[o.userId] = 'already';
          return next;
        });
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  if (opponents.length === 0) return null;
  const sendable = opponents.filter((o) => o.userId && (state[o.userId] ?? 'idle') !== 'already');
  if (sendable.length === 0) return null;

  async function add(userId: string, username: string) {
    const token = useAuthStore.getState().accessToken;
    if (!token || state[userId] === 'sending' || state[userId] === 'sent') return;
    setState((s) => ({ ...s, [userId]: 'sending' }));
    try {
      await friendsApi.request(token, username);
      setState((s) => ({ ...s, [userId]: 'sent' }));
      useGameStore.setState({ toast: t('table.friendRequestSent', { name: username }), toastKind: 'success' });
    } catch (e) {
      // A genuine FAILURE (network / 429 / 500 / self). The server returns ok for the already-friends
      // case (no throw), so an error here is retryable → revert to 'idle' (was 'already', which hid the
      // button permanently on a transient blip) and surface the error.
      setState((s) => ({ ...s, [userId]: 'idle' }));
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('table.friendRequestFailed'), toastKind: 'error' });
    }
  }

  return (
    <div className="mb-4">
      <div className="font-serif text-[10px] tracking-[0.3em] text-muted uppercase mb-1.5">{t('table.addOpponents')}</div>
      <div className="flex flex-wrap justify-center gap-2">
        {sendable.map((o) => {
          const st = state[o.userId!] ?? 'idle';
          return (
            <button
              key={o.userId}
              onClick={() => { sound.play('button'); void add(o.userId!, o.username!); }}
              disabled={st === 'sending' || st === 'sent'}
              className={`btn btn-sm ${st === 'sent' ? 'btn-ghost opacity-70' : 'btn-ghost'}`}
            >
              {st === 'sent' ? `✓ ${o.username}` : `＋ ${t('table.addFriend')} ${o.username}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function TableView({ room }: { room: RoomStateDTO }) {
  const { ls, forced } = useForceLandscape(); // landscape-only: rotate if held portrait
  useWakeLock(true); // keep the screen awake the whole time the player is at the table (re-acquires on resume)
  // Select only what the table renders (with shallow equality) so unrelated
  // store changes — log appends, lobby pushes, toasts — don't re-render the felt.
  const {
    game, pileHistory, gameIndex, mySeat, myHand, selected, scoreboard, switchPrompt, switchPending, noSwapNotice, switchCards, matchResult, rematchOffer,
    fairReveal, bubbles, handStandings, handReady, handHumans, spectators,
    toggleCardSel, clearSelection, play, pass, giveSwitch, leaveRoom, dismissResult, rematch, continueHand,
  } = useGameStore(
    useShallow((s) => ({
      game: s.game, pileHistory: s.pileHistory, gameIndex: s.gameIndex, mySeat: s.mySeat, myHand: s.myHand, selected: s.selected,
      scoreboard: s.scoreboard, switchPrompt: s.switchPrompt, switchPending: s.switchPending, noSwapNotice: s.noSwapNotice, switchCards: s.switchCards, matchResult: s.matchResult, rematchOffer: s.rematchOffer,
      fairReveal: s.fairReveal, bubbles: s.bubbles, handStandings: s.handStandings, handReady: s.handReady, handHumans: s.handHumans, spectators: s.spectators,
      toggleCardSel: s.toggleCardSel, clearSelection: s.clearSelection, play: s.play, pass: s.pass,
      giveSwitch: s.giveSwitch, leaveRoom: s.leaveRoom, dismissResult: s.dismissResult, rematch: s.rematch, continueHand: s.continueHand,
    })),
  );

  const t = useT();
  const [chatKind, setChatKind] = useState<'emote' | 'chat' | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const bubbleFor = (seat: number) => bubbles.filter((b) => b.seat === seat).slice(-1)[0];

  // Inter-hand standings: hold ~1.1s after the hand ends so the FINAL play stays clearly
  // visible on the (frozen) felt before the standings overlay fades in. Cleared when the
  // next hand deals (handStandings → null via game:start).
  const [showStandings, setShowStandings] = useState(false);
  useEffect(() => {
    if (!handStandings) { setShowStandings(false); return; }
    const id = setTimeout(() => setShowStandings(true), 1100);
    return () => clearTimeout(id);
  }, [handStandings]);

  // Warn before a tab close / navigation while a live paid match is in progress —
  // the in-app forfeit confirm is otherwise bypassed by closing the tab, which
  // disconnects and (after the grace) forfeits the stake.
  useEffect(() => {
    if (!(room.status === 'inMatch' && !matchResult)) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [room.status, matchResult]);

  const { cardBack, tableFelt } = useCosmeticsStore();
  const feltClass = tableFelt ?? ''; // '' → default green felt; else felt_red/felt_emerald/felt_midnight
  const cbClass = cardBack && cardBack !== 'cb_classic' ? cardBack : '';

  const numPlayers = PLAYERS_PER_TYPE[room.type];
  const nameOf = (seat: number) => room.seats[seat]?.username ?? t('table.seatN', { n: seat + 1 });

  // `!handStandings`: during the inter-hand pause the felt is the FINISHED game (frozen),
  // so it's nobody's turn — suppress turn UI/announcements until the next hand deals.
  const isMyTurn = game !== null && mySeat !== null && game.turn === mySeat && !handStandings;
  const canPass = game?.pile != null; // leading (no pile) forbids passing
  const holdsThreeSpades = myHand.some((c) => c.kind === 'standard' && c.rank === '3' && c.suit === 'S');
  const requireThreeSpades = gameIndex === 0 && game?.pile == null && isMyTurn && holdsThreeSpades;
  const passedSet = new Set(game?.passed ?? []);
  const finishedSet = new Set(game?.finishingOrder ?? []);
  const goneSet = new Set(game?.gone ?? []); // seats whose player abandoned (auto-passed, last)
  const myTeam = mySeat !== null ? room.seats[mySeat]?.team ?? null : null;
  const iWon = matchResult ? matchResult.winnerSeats.includes(mySeat ?? -1) : false;
  // Ranked transparency: my own MMR change for this match (present only when a
  // ranked season is active). Keyed by userId since seats are per-room.
  const myUserId = mySeat !== null ? room.seats[mySeat]?.userId ?? null : null;
  const myDelta = matchResult?.ratingDeltas?.find((d) => d.userId === myUserId) ?? null;

  // Card-switch: the winner returns a rank-3–10 card to the loser. Handled
  // ON the real hand (no blurring modal) — tap an eligible card to give it.
  const switching = !!switchPrompt && switchPrompt.winner === mySeat;
  const eligibleSwitchIds = switching ? new Set(myHand.filter(isReturnEligible).map(cardKey)) : null;
  // While a card-switch is in progress (winner picking, loser→winner pending, or the give/return
  // reveal) HIDE the centre pile: it still holds the PREVIOUS hand's last-played card, which — sitting
  // on the table beside a freshly-dealt hand that may share that rank — looks like a duplicate card.
  // It reappears the moment the switch completes and the new hand's first card is played.
  const hidePile = switching || switchPending || !!switchCards;
  // The card the winner has PICKED to return — held until they confirm, so an
  // accidental tap never sends a card. Cleared once the switch is over.
  const [switchPick, setSwitchPick] = useState<Card | null>(null);
  useEffect(() => { if (!switching) setSwitchPick(null); }, [switching]);
  // useCallback'd so the memoized <Hand> only re-renders when the hand/selection/switch
  // state actually changes — not on every unrelated table update.
  const onCardTap = useCallback((id: string) => {
    if (switching) {
      const card = myHand.find((c) => cardKey(c) === id);
      if (card && isReturnEligible(card)) { sound.play('select'); setSwitchPick(card); } // pick → confirm (no instant send)
      else useGameStore.setState({ toast: t('table.switchHint'), toastKind: 'info' });
      return;
    }
    sound.play('select');
    toggleCardSel(id);
  }, [switching, myHand, t, toggleCardSel]);
  const confirmSwitch = () => { if (switchPick) { sound.play('card'); void giveSwitch(switchPick); setSwitchPick(null); } };

  const opponents = room.seats.filter((s) => s.seat !== mySeat);

  // Focus traps for the hand-rolled game dialogs (a11y: keep Tab inside the dialog and
  // restore focus on close). Each is gated on its own visibility so it only engages
  // while that overlay is mounted. The standings + match-over auto-advance, so they get
  // no Escape handler (matches existing behaviour); the forfeit confirm IS dismissable,
  // so Escape closes it (= "stay").
  const standingsVisible = showStandings && !!handStandings && !matchResult && !switching;
  const standingsTrapRef = useFocusTrap<HTMLDivElement>(standingsVisible);
  const matchOverTrapRef = useFocusTrap<HTMLDivElement>(!!matchResult);
  const forfeitTrapRef = useFocusTrap<HTMLDivElement>(confirmLeave);
  useEffect(() => {
    if (!confirmLeave) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setConfirmLeave(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmLeave]);

  // ----- Game-feel SFX (presentational side-effects on state transitions) ----
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const wasGameActive = useRef(false);
  const wasMyTurn = useRef(false);
  const hadResult = useRef(false);
  const [shake, setShake] = useState(false);
  const lastPileKey = useRef('');
  const shakeTimer = useRef<number | null>(null);
  const [finishFx, setFinishFx] = useState(false);
  const prevFinishing = useRef<number[]>([]);
  const finishTimer = useRef<number | null>(null);

  useEffect(() => {
    const active = game !== null;
    if (active && !wasGameActive.current) sound.play('deal'); // a fresh hand was dealt
    wasGameActive.current = active;
  }, [game]);

  useEffect(() => {
    if (isMyTurn && !wasMyTurn.current) { sound.play('turn'); haptics.turn(); }
    wasMyTurn.current = isMyTurn;
  }, [isMyTurn]);

  // 5s-before-deadline warning (the on-screen bar was removed, but a missed turn auto-
  // passes and can cost real money). Only on MY turn; the top timer shows the countdown.
  useEffect(() => {
    const deadline = game?.turnDeadline ?? null;
    if (!isMyTurn || deadline === null) return;
    const fireIn = deadline - 5000 - Date.now();
    if (fireIn <= 0) return;
    const id = window.setTimeout(() => { sound.play('warn'); haptics.warn(); }, fireIn);
    return () => window.clearTimeout(id);
  }, [isMyTurn, game?.turnDeadline]);

  useEffect(() => {
    const has = matchResult !== null;
    if (has && !hadResult.current) {
      sound.play(iWon ? 'win' : 'lose');
      if (iWon) haptics.win(); else haptics.lose();
      void refreshMe(); // re-read the authoritative balance so the chip counts up
    }
    hadResult.current = has;
  }, [matchResult, iWon, refreshMe]);

  // AAA feel: when a bomb (four-of-a-kind) lands on the pile — from ANY player —
  // thump the speakers, buzz the phone, and shake the table. Keyed off a content
  // hash of the pile so it fires once per distinct play (the DTO re-creates the
  // pile object every broadcast). Reduced-motion disables the shake (CSS) + buzz.
  useEffect(() => {
    const pile = game?.pile ?? null;
    const key = pile ? pile.cards.map(cardKey).join(',') : '';
    if (key !== lastPileKey.current) {
      lastPileKey.current = key;
      if (pile?.type === 'bomb') {
        sound.play('bomb');
        haptics.bomb();
        setShake(true);
        if (shakeTimer.current) window.clearTimeout(shakeTimer.current);
        shakeTimer.current = window.setTimeout(() => setShake(false), 460);
      }
    }
  }, [game]);

  // AAA feel: when a player empties their hand (goes out), give the centre pile a
  // brief slow-mo emphasis. `finishingOrder` growing = a new finisher (source of
  // truth on the server); a new game resets it to [] (wentOutSeat returns null on
  // a shorter list, so the reset is silent). Fires once per finisher.
  useEffect(() => {
    const next = game?.finishingOrder ?? [];
    const seat = wentOutSeat(prevFinishing.current, next);
    prevFinishing.current = next;
    if (seat === null) return;
    sound.play('select');
    haptics.tap();
    setFinishFx(true);
    if (finishTimer.current) window.clearTimeout(finishTimer.current);
    finishTimer.current = window.setTimeout(() => setFinishFx(false), 800);
  }, [game]);

  useEffect(() => () => {
    if (shakeTimer.current) window.clearTimeout(shakeTimer.current);
    if (finishTimer.current) window.clearTimeout(finishTimer.current);
  }, []);

  // Win theater: count the winnings up from 0 shortly after the overlay pops in.
  const [shownPayout, setShownPayout] = useState(0);
  useEffect(() => {
    if (!(matchResult && iWon && matchResult.payoutCents)) { setShownPayout(0); return; }
    setShownPayout(0);
    const id = window.setTimeout(() => setShownPayout(matchResult.payoutCents ?? 0), 360);
    return () => window.clearTimeout(id);
  }, [matchResult, iWon]);

  // ----- Shared content (identical handlers/props in BOTH layouts) ------------
  // Built once and placed by either the portrait/desktop flow layout or the
  // landscape fixed-aspect canvas — the leaf components, props, and handlers are
  // the SAME; only WHERE they render and at what % size differs.

  // Top-bar left group: leave + the running score.
  const topLeft = (
    <div className="flex items-center gap-2 min-w-0">
      <button
        onClick={() => { if (room.status === 'inMatch' && !matchResult) setConfirmLeave(true); else void leaveRoom(); }}
        className="btn btn-ghost shrink-0"
      >
        {t('table.leaveArrow')}
      </button>
      {scoreboard && (
        <span
          className="inline-flex items-center gap-1.5 text-sm leading-none whitespace-nowrap font-display"
          title={t('scoreboard.result')}
        >
          {(scoreboard.type === '2v2' && scoreboard.teamTotals
            ? scoreboard.teamTotals.map((v, i) => ({ label: `T${i + 1}`, val: v }))
            : scoreboard.cumulative.map((v, i) => ({ label: (nameOf(i) || String(i + 1)).slice(0, 8), val: v }))
          ).map((s, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 && <span className="opacity-30">·</span>}
              <span className="text-muted">{s.label}</span>
              <b className="text-gold-hi tabular-nums">{s.val}</b>
            </span>
          ))}
          <span className="opacity-50 ml-0.5 text-xs">→ {scoreboard.target}</span>
        </span>
      )}
    </div>
  );
  // Top-bar right group: spectators + turn timer + history/chat/emoji icons.
  const topRight = (
    <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
      {spectators > 0 && (
        <span
          className="inline-flex items-center gap-1 text-xs border border-gold-line/40 bg-black/25 rounded-full px-2 py-1 leading-none text-cream/80"
          title={t('table.spectators', { n: spectators })}
          aria-label={t('table.spectators', { n: spectators })}
        >
          <span aria-hidden>👁</span>{spectators}
        </span>
      )}
      <TurnTimer deadline={game?.turnDeadline ?? null} />
      <button className="iconbtn" onClick={() => { sound.play('button'); setChatKind('chat'); }} title={t('table.chat')} aria-label={t('table.chat')}>💬</button>
      <button className="iconbtn" onClick={() => { sound.play('button'); setChatKind('emote'); }} title={t('table.emote')} aria-label={t('table.emote')}>😊</button>
    </div>
  );

  // One opponent seat (avatar + gold stack + name + badges + speech bubble).
  const renderSeat = (s: (typeof opponents)[number], pos: SeatPosition) => {
    const bub = bubbleFor(s.seat);
    return (
      <>
        {bub && <SpeechBubble b={bub} />}
        <button onClick={() => s.userId && setProfileId(s.userId)} className="block" title={t('table.viewProfile')}>
          <SeatBadge
            name={nameOf(s.seat)}
            avatar={s.avatar}
            count={game?.handCounts?.[s.seat] ?? 0}
            team={room.type === '2v2' ? s.team : null}
            isTurn={game?.turn === s.seat}
            connected={s.connected}
            finished={finishedSet.has(s.seat)}
            passed={passedSet.has(s.seat)}
            gone={goneSet.has(s.seat)}
            lastPlayer={game?.pileOwner === s.seat}
            partner={room.type === '2v2' && myTeam !== null && s.team === myTeam}
            turnDeadline={game?.turn === s.seat ? game?.turnDeadline ?? null : null}
            placement={pos}
          />
        </button>
      </>
    );
  };

  // Centre pile (pointer-events:none so it never steals taps from the hand below).
  const pileEl = hidePile ? null : (
    <div className={`absolute inset-0 grid place-items-center z-[3] pointer-events-none${finishFx ? ' finish-pop' : ''}`}>
      <Pile pile={game?.pile ?? null} history={pileHistory} />
    </div>
  );

  // The hand + (when not switching) the Play/Pass controls — same components,
  // same handlers, in both layouts.
  const handBlock = (
    <Hand cards={myHand} selected={switching ? (switchPick ? [cardKey(switchPick)] : []) : selected} onToggle={onCardTap} eligibleIds={eligibleSwitchIds} dealAnimate fit={ls} />
  );
  const controlsBlock = !switching ? (
    <Controls
      selectedCards={selectedCards(myHand, selected)}
      pile={game?.pile ?? null}
      isMyTurn={isMyTurn}
      canPass={canPass}
      requireThreeSpades={requireThreeSpades}
      onPlay={() => { sound.play('card'); haptics.tap(); void play(); }}
      onPass={() => { sound.play('pass'); void pass(); }}
      onClear={clearSelection}
    />
  ) : null;
  // The card-switch confirm bar OR my floating emote/chat bubble (above the hand).
  const switchOrBubble = switching ? (
    <div className="text-center pb-1.5">
      {switchPick ? (
        <div className="flex items-center justify-center gap-2 flex-wrap animate-pop">
          <span className="text-sm text-txt">{t('table.switchConfirmQ', { card: cardLabel(switchPick) })}</span>
          <button className="btn btn-gold btn-sm" onClick={confirmSwitch}>{t('table.switchConfirm')}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setSwitchPick(null)}>{t('table.switchCancel')}</button>
        </div>
      ) : (
        <span className="inline-block animate-pop panel-solid rounded-xl px-4 py-2 text-gold-hi font-display font-semibold text-sm leading-snug max-w-[88vw]">
          {t('table.youWinSwitch')}
        </span>
      )}
    </div>
  ) : (() => {
    const myBubble = mySeat !== null ? bubbleFor(mySeat) : undefined;
    return myBubble ? (
      <div className="absolute left-1/2 bottom-full mb-1 -translate-x-1/2 text-center pointer-events-none z-30">
        <span className="inline-block animate-pop panel-solid rounded-xl px-3 py-1 max-w-[220px] truncate">
          {myBubble.kind === 'emote'
            ? <span className="text-xl leading-none">{myBubble.text}</span>
            : <span className="text-sm text-txt">{myBubble.text}</span>}
        </span>
      </div>
    ) : null;
  })();

  // ----- The two table layouts (portrait/desktop flow vs landscape canvas) ----

  // PORTRAIT / DESKTOP: the original vertical flow layout — UNCHANGED.
  const flowLayout = (
    <>
      {/* Top bar (corner controls live here so they never overlap seats) */}
      <div className="tv-top flex items-center justify-between gap-2 pt-3 pb-1">
        {topLeft}
        {topRight}
      </div>

      {/* Score is now shown compactly in the top bar (above) — no separate bar. */}

      {/* Table — grows to fill the space between the scorebar and the hand */}
      <div className="tv-table flex-1 flex items-center justify-center min-h-0 py-1">
        <div className={`tv-felt relative w-full max-w-[640px] px-7 py-6 max-[480px]:px-3 ${feltClass} ${cbClass}`}>
          <div className="rail-outer">
          <div className="rail-inner">
            <div className={`felt-ring${game?.pile ? ' live' : ''}`} aria-hidden />
            <div className="tlogo">MURLAN</div>

            {/* Opponent seats (counts only — never card identities) */}
            {mySeat !== null &&
              opponents.map((s) => {
                const pos = seatPosition(numPlayers, mySeat, s.seat);
                return (
                  <div key={s.seat} className={`tv-seat tv-seat-${pos} absolute z-[5] ${SEAT_POS[pos]}`}>
                    {renderSeat(s, pos)}
                  </div>
                );
              })}

            {/* Centre pile (above the betting ring + logo). */}
            {pileEl}
          </div>
          </div>
        </div>
      </div>

      {/* My hand + controls (no framing box — cards sit on the table surface). */}
      <div className="tv-bottom pt-1 relative z-20">
        {switchOrBubble}
        {handBlock}
        {controlsBlock}
      </div>
    </>
  );

  // LANDSCAPE: ONE fixed-aspect (1280/590 ≈ 2.17:1) canvas that scales to FIT the
  // screen (contain) and is centered both axes — letterboxed on a phone whose ratio
  // differs. EVERY element is absolutely positioned by % of this ONE container and
  // sized in % of its width/height; centers (cx,cy) use translate(-50%,-50%).
  // `container-type: size` lets inner font-sizes use cqw/cqh.
  const canvasLayout = (
    <div className="tv-canvas-wrap">
      <div className={`tv-canvas ${feltClass} ${cbClass}`}>
        {/* Top bar — Largohu (left), then timer + history/chat/emoji (right). */}
        <div className="tvc-topbar">
          {topLeft}
          {topRight}
        </div>

        {/* Felt / table: rounded-rect at left 22% top 9% w 56% h 51%. */}
        <div className={`tvc-felt ${feltClass} ${cbClass}`}>
          <div className="rail-outer">
            <div className="rail-inner">
              <div className={`felt-ring${game?.pile ? ' live' : ''}`} aria-hidden />
              <div className="tlogo">MURLAN</div>
            </div>
          </div>
        </div>

        {/* Centre played pile — center (50%, 38.5%). pointer-events:none so it never
            steals a tap meant for the hand below; finish-pop on a go-out. */}
        {!hidePile && (
          <div className={`tvc-pile${finishFx ? ' finish-pop' : ''}`}>
            <Pile pile={game?.pile ?? null} history={pileHistory} />
          </div>
        )}

        {/* Opponent seats — absolutely placed at their spec center coordinates. */}
        {mySeat !== null &&
          opponents.map((s) => {
            const pos = seatPosition(numPlayers, mySeat, s.seat);
            const slot = LS_SEAT_SLOT[pos];
            if (!slot) return null; // local player — no avatar
            const cxy = LS_SEAT_CXY[slot];
            return (
              <div
                key={s.seat}
                className={`tvc-seat tvc-seat-${slot}`}
                style={{ left: `${cxy.cx}%`, top: `${cxy.cy}%` }}
              >
                {renderSeat(s, pos)}
              </div>
            );
          })}

        {/* Hand zone. When it's NOT my turn (and not the card switch) the fan sinks + shrinks
            via the `.active` class below, so each player can tell at a glance when it's their
            turn; on my turn it rises to full size. */}
        <div className={`tvc-hand${(isMyTurn || switching) ? ' active' : ''}`}>
          {!switching ? switchOrBubble : null}
          {handBlock}
        </div>

        {/* During the card switch the confirm bar must NOT live inside the tall, bottom-
            anchored hand zone (the cards bury it). Render it as a clear floating panel on
            TOP of everything — Play/Pass are hidden during the switch so the bottom is free. */}
        {switching ? <div className="tvc-switch">{switchOrBubble}</div> : null}

        {/* Pas / Luaj round buttons — pinned by CSS; only shown (faded in) on MY turn. */}
        <div className={`tvc-controls${isMyTurn ? ' is-on' : ''}`}>{controlsBlock}</div>
      </div>
    </div>
  );

  return (
    // Safe-area insets: this is the main gameplay screen and renders OUTSIDE the
    // lobby Shell, so it must inset itself or the top controls sit under the iPhone
    // notch / Dynamic Island and the hand under the home indicator (audit finding H10).
    // In landscape (`ls`) the table becomes a single fixed-aspect CANVAS; portrait/
    // desktop keep the original vertical flow layout. ALL overlays/modals below are
    // rendered as siblings (fixed / modal-backdrop) so the canvas can never clip them.
    <div className={`tv-root relative z-10 min-h-[100dvh] flex flex-col mx-auto w-full max-w-[680px]${ls ? ' tv-ls' : ''}${shake ? ' shake-fx' : ''}`}>
      <h1 className="sr-only">{t('table.title')}</h1>
      <GameAnnouncer
        isMyTurn={isMyTurn}
        result={matchResult ? (iWon ? t('table.youWon') : t('table.winnerWas', { names: matchResult.winnerSeats.map((s) => nameOf(s)).join(' & ') })) : null}
      />
      {forced && <RotateOverlay />}

      {ls ? canvasLayout : flowLayout}

      {/* Shuffle splash: ONLY at match start / between deals — never during the
          card switch (which would cover the winner's hand and block the give). */}
      {game === null && !matchResult && !switching && !switchPending && (
        <div className={`fixed inset-0 z-40 flex flex-col items-center justify-center bg-black/70 gap-4 ${cbClass}`} role="status" aria-live="polite">
          <div className="flex gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              // Use the player's equipped card-back (--cb, set by cbClass) so a
              // purchased back is actually visible to its buyer during the shuffle.
              <div key={i} className="w-9 h-14 rounded-lg animate-shuffle" style={{ animationDelay: `${i * 90}ms`, background: 'var(--cb, repeating-linear-gradient(45deg,#8f2620 0 4px,#a23029 4px 8px))', boxShadow: 'inset 0 0 0 1.5px #f1deae' }} />
            ))}
          </div>
          <div className="gold-text font-display font-semibold tracking-wide">{t('table.shuffling')}</div>
        </div>
      )}

      {/* Inter-hand standings: after a hand ends the final board stays frozen (~1.1s) so
          the winning play is visible, then this fades in — players + points ranked
          most→least, my row highlighted, this hand's winner badged. Everyone taps
          Continue to advance early; otherwise the server auto-deals after the pause. */}
      {showStandings && handStandings && !matchResult && !switching && (() => {
        const sb = handStandings.scoreboard;
        const handWinner = handStandings.finishingOrder[0];
        const rows = sb.cumulative
          .map((pts, seat) => ({ seat, pts, name: nameOf(seat), isMe: seat === mySeat, wonHand: seat === handWinner, team: room.seats[seat]?.team ?? null }))
          .sort((a, b) => b.pts - a.pts);
        const iReady = mySeat != null && handReady.includes(mySeat);
        return (
          <div className="modal-backdrop !z-[55]" role="dialog" aria-modal="true" aria-label={t('table.standingsTitle')}>
            {/* Flex column so the title + Continue button are always visible and the panel
                stays CENTERED + scroll-free on a short landscape phone (≤4 player rows fit;
                the list is the only thing that could ever shrink/scroll, never the button). */}
            <div ref={standingsTrapRef} tabIndex={-1} className="panel-solid w-full max-w-sm max-h-[92dvh] flex flex-col overflow-hidden p-4 text-center animate-pop outline-none">
              <div className="shrink-0">
                <div className="text-2xl mb-0.5">🏁</div>
                <h2 className="gold-text font-display font-bold tracking-wide text-lg leading-tight">{t('table.standingsTitle')}</h2>
                <p className="text-[11px] text-muted mb-2">{t('table.handDone', { n: handStandings.gameIndex + 1 })} · {t('table.toTarget', { n: sb.target })}</p>
              </div>
              <ol className="text-left space-y-1 flex-1 min-h-0 overflow-y-auto no-scrollbar">
                {rows.map((r, i) => (
                  <li key={r.seat} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 border ${r.isMe ? 'border-gold-line/60 bg-gold-line/10' : 'border-white/10 bg-white/[.03]'}`}>
                    <span className="w-5 text-sm font-display font-bold text-muted tabular-nums">{i + 1}</span>
                    <span className={`flex-1 truncate text-sm ${r.isMe ? 'text-gold-hi font-semibold' : 'text-txt'}`}>
                      {r.name}{r.wonHand ? ' 🏆' : ''}{room.type === '2v2' && r.team != null ? ` · ${t('table.squad', { n: r.team + 1 })}` : ''}
                    </span>
                    <b className="text-gold-hi tabular-nums text-base">{r.pts}</b>
                  </li>
                ))}
              </ol>
              <button autoFocus onClick={() => { sound.play('button'); continueHand(); }} disabled={iReady} className="btn btn-gold btn-block shrink-0 mt-3">
                {iReady ? t('table.waitingOthers', { n: handReady.length, total: Math.max(handHumans, handReady.length) }) : t('table.continue')}
              </button>
            </div>
          </div>
        );
      })()}

      {/* "No swap" banner: the previous loser held both jokers, so no card switch
          happened this game and the winner leads. Flashed for a few seconds. */}
      {noSwapNotice && !matchResult && (
        <div className="fixed left-1/2 top-20 -translate-x-1/2 z-50 pointer-events-none" role="status" aria-live="polite">
          <span className="inline-block panel-solid rounded-xl px-5 py-2.5 text-gold-hi font-display font-bold tracking-[0.2em] text-base animate-pop ring-1 ring-gold-hi/40">
            {t('table.noSwap')}
          </span>
        </div>
      )}

      {/* Swap reveal: the two exchanged cards, shown on the table (only the winner
          + loser receive their identities; other seats get a redacted notice). */}
      {switchCards && (switchCards.given || switchCards.returned) && !matchResult && (
        <div className="fixed left-1/2 top-16 -translate-x-1/2 z-50 pointer-events-none" role="status" aria-live="polite">
          <div className="panel-solid rounded-2xl px-4 py-2.5 flex items-center gap-4 animate-pop ring-1 ring-gold-hi/30">
            <span className="font-display text-xs text-gold-hi tracking-[0.2em] uppercase">{t('table.swapTitle')}</span>
            {switchCards.given && (
              <div className="flex flex-col items-center gap-1">
                <CardView card={switchCards.given} small />
                <span className="text-[9px] text-cream/80 whitespace-nowrap">{t('table.swapGave')}</span>
              </div>
            )}
            {switchCards.returned && (
              <div className="flex flex-col items-center gap-1">
                <CardView card={switchCards.returned} small />
                <span className="text-[9px] text-cream/80 whitespace-nowrap">{t('table.swapReturned')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Card switch in progress, but I'm NOT the winner: a small non-blocking
          notice (no full-screen splash) so I can see the table while I wait. */}
      {switchPending && !switching && !matchResult && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-28 z-40 pointer-events-none" role="status" aria-live="polite">
          <span className="inline-block panel-solid rounded-xl px-4 py-2 gold-text font-display font-semibold tracking-wide text-sm animate-pop">
            {t('table.oppSwitching')}
          </span>
        </div>
      )}

      {/* (Card-switch is handled inline on the real hand above — no modal/blur.) */}

      {/* Match-end celebration */}
      {matchResult && iWon && <Confetti />}
      {matchResult && (
        <div className="modal-backdrop !z-[60]" role="dialog" aria-modal="true" aria-label={t('table.matchOver')}>
          <div ref={matchOverTrapRef} tabIndex={-1} className="panel-solid w-full max-w-sm p-7 text-center animate-pop outline-none">
            <div className="text-5xl mb-2">{iWon ? '🏆' : '🃏'}</div>
            <h2 className="gold-text font-display font-bold tracking-wide text-3xl mb-1">{t('table.matchOverBang')}</h2>
            <p className="text-sm text-muted mb-4">
              {iWon ? t('table.youWon') : t('table.winnerWas', { names: matchResult.winnerSeats.map((s) => nameOf(s)).join(' & ') })}
            </p>

            {/* Winnings reveal — counts up from 0 (staked matches only). */}
            {iWon && matchResult.payoutCents != null && matchResult.payoutCents > 0 && (
              <div className="mb-4 pot-slide">
                <div className="font-serif text-[10px] tracking-[0.3em] text-muted uppercase mb-0.5">{t('table.winnings')}</div>
                <CountUp valueCents={shownPayout} className="gold-text font-display font-bold text-4xl tracking-wide" />
              </div>
            )}

            {/* Ranked transparency: my MMR change + the pre-match win probability
                (only shown when a ranked season is active). Counters "rigged"
                accusations — the rating math is unchanged whether or not this shows. */}
            {myDelta && (() => {
              const change = myDelta.newRating - myDelta.oldRating;
              const pct = Math.round(myDelta.expectedWinRate * 100);
              return (
                <div className="mb-4">
                  <div className="font-serif text-[10px] tracking-[0.3em] text-muted uppercase mb-0.5">{t('table.ratingMmr')}</div>
                  <div className="flex items-center justify-center gap-2">
                    <span className="font-display font-bold text-2xl tracking-wide text-txt tabular-nums">{myDelta.newRating}</span>
                    <span className={`font-display font-semibold text-lg tabular-nums ${change >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                      {change >= 0 ? `+${change}` : change}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted/80 mt-0.5">{t('table.winProbability', { pct })}</div>
                </div>
              );
            })()}

            {/* Final standings */}
            <div className="text-left bg-black/30 rounded-xl p-3 mb-5 space-y-1.5">
              {matchResult.scoreboard.type === '2v2' && matchResult.scoreboard.teamTotals
                ? ([0, 1] as const).map((ti) => {
                    const winTeam = matchResult.winnerSeats.length ? room.seats[matchResult.winnerSeats[0]]?.team ?? null : null;
                    return (
                      <div key={ti} className={`flex justify-between text-sm ${winTeam === ti ? 'text-gold-hi font-semibold' : 'text-txt'}`}>
                        <span>{t('table.squad', { n: ti + 1 })} {winTeam === ti && '🏆'}</span>
                        <b>{matchResult.scoreboard.teamTotals![ti]}</b>
                      </div>
                    );
                  })
                : matchResult.scoreboard.cumulative.map((pts, seat) => (
                    <div key={seat} className={`flex justify-between text-sm ${matchResult.winnerSeats.includes(seat) ? 'text-gold-hi font-semibold' : 'text-txt'}`}>
                      <span className="truncate max-w-[180px]">{nameOf(seat)} {matchResult.winnerSeats.includes(seat) && '🏆'}</span>
                      <b>{pts}</b>
                    </div>
                  ))}
            </div>

            {/* Add recent opponents as friends (humans only, not already friends). */}
            <AddFriendButtons room={room} mySeat={mySeat} />

            {/* No rematch on a tournament pairing — the bracket advances itself. */}
            {!room.tournament && (() => {
              const total = room.seats.filter((s) => s.userId).length;
              const iAccepted = !!rematchOffer && myUserId != null && rematchOffer.accepted.includes(myUserId);
              if (iAccepted) {
                return (
                  <button disabled className="btn btn-gold btn-lg btn-block opacity-80">
                    {t('table.rematchWaiting', { n: rematchOffer!.accepted.length, total })}
                  </button>
                );
              }
              return (
                <button autoFocus onClick={() => { sound.play('button'); void rematch(); }} className="btn btn-gold btn-lg btn-block">
                  {rematchOffer ? t('table.rematchJoin', { n: rematchOffer.accepted.length, total }) : t('table.playAgain')}
                </button>
              );
            })()}
            <button onClick={() => { dismissResult(); void leaveRoom(); }} className={`btn btn-ghost btn-block ${room.tournament ? '' : 'mt-2'}`}>
              {t('table.returnLobby')}
            </button>

            {/* Brag: share the (provably-fair) replay of YOUR win to Telegram — a one-tap
                viral loop. Opens Telegram's share composer with the replay link + a brag line. */}
            {iWon && fairReveal?.matchId && (
              <button
                onClick={() => {
                  const url = `${window.location.origin}/?replay=${encodeURIComponent(fairReveal.matchId!)}`;
                  const tg = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(t('table.shareWin'))}`;
                  window.open(tg, '_blank', 'noopener,noreferrer');
                }}
                className="btn btn-ghost btn-block btn-sm mt-2"
              >
                📣 {t('table.shareTelegram')}
              </button>
            )}

            {/* Provably-fair: open the in-app replay + verifier — recomputes every
                deal IN THE BROWSER from the revealed seeds, checks them against the
                committed hash, and replays every move. */}
            {fairReveal?.matchId && (
              <button
                onClick={() => { const id = fairReveal.matchId!; dismissResult(); void leaveRoom(); useUiStore.getState().openReplay(id); }}
                className="block mt-3 text-xs text-gold-hi/80 hover:text-gold-hi border-b border-dashed border-gold/40 mx-auto"
                style={{ width: 'fit-content' }}
              >
                {t('table.replayVerify')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Emote / quick-chat popover + tapped-seat profile + history */}
      {chatKind && <EmoteChat kind={chatKind} onClose={() => setChatKind(null)} />}
      {profileId && <ProfileModal userId={profileId} onClose={() => setProfileId(null)} />}
      {logOpen && <LogPanel onClose={() => setLogOpen(false)} />}

      {/* Confirm before forfeiting a live match (real money is at stake) */}
      {confirmLeave && (
        <div className="modal-backdrop !z-[62]" role="dialog" aria-modal="true" aria-label={t('table.leaveMatch')}>
          <div ref={forfeitTrapRef} tabIndex={-1} className="panel-solid w-full max-w-sm p-6 text-center animate-pop outline-none">
            <div className="text-4xl mb-2">⚠️</div>
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-xl mb-1">{t('table.leaveConfirm')}</h2>
            <p className="text-sm text-muted mb-5">
              {room.stakeCents > 0
                ? t('table.leaveStakeWarn', { amount: dollars(room.stakeCents) })
                : t('table.leaveWarn')}
            </p>
            <div className="flex gap-3">
              <button autoFocus className="btn btn-ghost flex-1" onClick={() => setConfirmLeave(false)}>{t('table.stay')}</button>
              <button className="btn btn-danger flex-1" onClick={() => { setConfirmLeave(false); void leaveRoom(); }}>{t('table.leave')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
