import { useEffect, useRef, useState, type CSSProperties } from 'react';
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
import { dollars } from '../lib/money.ts';
import { wentOutSeat } from '../lib/finish.ts';
import { Hand } from '../components/Hand.tsx';
import { PlayLog } from '../components/PlayLog.tsx';
import { Pile } from '../components/Pile.tsx';
import { CardView } from '../components/CardView.tsx';
import { SeatBadge } from '../components/SeatBadge.tsx';
import { Controls } from '../components/Controls.tsx';
import { Scoreboard } from '../components/Scoreboard.tsx';
import { TurnTimer } from '../components/TurnTimer.tsx';
import { Confetti } from '../components/ui/Confetti.tsx';
import { CountUp } from '../components/ui/CountUp.tsx';
import { EmoteChat } from '../components/EmoteChat.tsx';
import { ProfileModal } from '../components/ui/ProfileModal.tsx';
import { useCosmeticsStore } from '../store/cosmeticsStore.ts';
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

/** Recessed cup-holders spaced around the padded rail (like a real poker table). */
function CupHolders() {
  const top = ['22%', '50%', '78%'];
  const side = ['34%', '66%'];
  const spots: Array<CSSProperties> = [
    ...top.map((l) => ({ left: l, top: '2px', transform: 'translateX(-50%)' })),
    ...top.map((l) => ({ left: l, bottom: '2px', transform: 'translateX(-50%)' })),
    ...side.map((t) => ({ left: '2px', top: t, transform: 'translateY(-50%)' })),
    ...side.map((t) => ({ right: '2px', top: t, transform: 'translateY(-50%)' })),
  ];
  return (
    <>
      {spots.map((s, i) => (
        <span key={i} className="cupholder" style={s} aria-hidden />
      ))}
    </>
  );
}

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
  return (
    <div className="modal-backdrop !z-[58]" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('table.gameHistory')}>
      <div className="panel-solid w-full max-w-sm p-5 animate-pop" onClick={(e) => e.stopPropagation()}>
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

export function TableView({ room }: { room: RoomStateDTO }) {
  // Select only what the table renders (with shallow equality) so unrelated
  // store changes — log appends, lobby pushes, toasts — don't re-render the felt.
  const {
    game, gameIndex, mySeat, myHand, selected, scoreboard, switchPrompt, switchPending, noSwapNotice, switchCards, matchResult,
    fairCommit, fairReveal, bubbles,
    toggleCardSel, clearSelection, play, pass, giveSwitch, leaveRoom, dismissResult, rematch,
  } = useGameStore(
    useShallow((s) => ({
      game: s.game, gameIndex: s.gameIndex, mySeat: s.mySeat, myHand: s.myHand, selected: s.selected,
      scoreboard: s.scoreboard, switchPrompt: s.switchPrompt, switchPending: s.switchPending, noSwapNotice: s.noSwapNotice, switchCards: s.switchCards, matchResult: s.matchResult,
      fairCommit: s.fairCommit, fairReveal: s.fairReveal, bubbles: s.bubbles,
      toggleCardSel: s.toggleCardSel, clearSelection: s.clearSelection, play: s.play, pass: s.pass,
      giveSwitch: s.giveSwitch, leaveRoom: s.leaveRoom, dismissResult: s.dismissResult, rematch: s.rematch,
    })),
  );

  const t = useT();
  const [chatKind, setChatKind] = useState<'emote' | 'chat' | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const bubbleFor = (seat: number) => bubbles.filter((b) => b.seat === seat).slice(-1)[0];

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

  const isMyTurn = game !== null && mySeat !== null && game.turn === mySeat;
  const canPass = game?.pile != null; // leading (no pile) forbids passing
  const holdsThreeSpades = myHand.some((c) => c.kind === 'standard' && c.rank === '3' && c.suit === 'S');
  const requireThreeSpades = gameIndex === 0 && game?.pile == null && isMyTurn && holdsThreeSpades;
  const passedSet = new Set(game?.passed ?? []);
  const finishedSet = new Set(game?.finishingOrder ?? []);
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
  // The card the winner has PICKED to return — held until they confirm, so an
  // accidental tap never sends a card. Cleared once the switch is over.
  const [switchPick, setSwitchPick] = useState<Card | null>(null);
  useEffect(() => { if (!switching) setSwitchPick(null); }, [switching]);
  const onCardTap = (id: string) => {
    if (switching) {
      const card = myHand.find((c) => cardKey(c) === id);
      if (card && isReturnEligible(card)) { sound.play('select'); setSwitchPick(card); } // pick → confirm (no instant send)
      else useGameStore.setState({ toast: t('table.switchHint'), toastKind: 'info' });
      return;
    }
    sound.play('select');
    toggleCardSel(id);
  };
  const confirmSwitch = () => { if (switchPick) { sound.play('card'); void giveSwitch(switchPick); setSwitchPick(null); } };

  const opponents = room.seats.filter((s) => s.seat !== mySeat);

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

  return (
    // Safe-area insets: this is the main gameplay screen and renders OUTSIDE the
    // lobby Shell, so it must inset itself or the top controls sit under the iPhone
    // notch / Dynamic Island and the hand under the home indicator (audit finding H10).
    <div className={`tv-root relative z-10 min-h-[100dvh] flex flex-col mx-auto w-full max-w-[680px]${shake ? ' shake-fx' : ''}`}>
      <h1 className="sr-only">{t('table.title')}</h1>
      {/* Top bar (corner controls live here so they never overlap seats) */}
      <div className="tv-top flex items-center justify-between gap-2 pt-3 pb-1">
        <button
          onClick={() => { if (room.status === 'inMatch' && !matchResult) setConfirmLeave(true); else void leaveRoom(); }}
          className="btn btn-ghost"
        >
          {t('table.leaveArrow')}
        </button>
        <div className="flex items-center gap-1.5 sm:gap-2">
          {fairCommit && (
            <span
              className="text-[11px] text-emerald-300/90 border border-emerald-400/30 rounded-full px-2 py-0.5"
              title={fairReveal ? `serverSeed: ${fairReveal.serverSeed}` : `commit: ${fairCommit.serverSeedHash}`}
            >
              {fairReveal ? '✓ fair' : '🔒 fair'}
            </span>
          )}
          <TurnTimer deadline={game?.turnDeadline ?? null} />
          <button className="iconbtn" onClick={() => { sound.play('button'); setLogOpen(true); }} title={t('table.historyTitle')} aria-label={t('table.gameHistory')}>☰</button>
          <button className="iconbtn" onClick={() => { sound.play('button'); setChatKind('chat'); }} title={t('table.chat')} aria-label={t('table.chat')}>💬</button>
          <button className="iconbtn" onClick={() => { sound.play('button'); setChatKind('emote'); }} title={t('table.emote')} aria-label={t('table.emote')}>😊</button>
        </div>
      </div>

      {/* Scorebar */}
      {scoreboard && (
        <div className="tv-score my-2">
          <Scoreboard scoreboard={scoreboard} names={nameOf} />
        </div>
      )}

      {/* Table — grows to fill the space between the scorebar and the hand */}
      <div className="tv-table flex-1 flex items-center justify-center min-h-0 py-1">
        <div className={`tv-felt relative w-full max-w-[640px] px-7 py-6 max-[480px]:px-3 ${feltClass} ${cbClass}`}>
          <div className="rail-outer">
          <CupHolders />
          <div className="rail-inner">
            <div className="felt-ring" aria-hidden />
            <div className="tlogo">MURLAN</div>

            {/* Opponent seats (counts only — never card identities) */}
            {mySeat !== null &&
              opponents.map((s) => {
                const pos = seatPosition(numPlayers, mySeat, s.seat);
                return (
                  <div key={s.seat} className={`absolute z-[5] ${SEAT_POS[pos]}`}>
                    {bubbleFor(s.seat) && <SpeechBubble b={bubbleFor(s.seat)!} />}
                    <button onClick={() => s.userId && setProfileId(s.userId)} className="block" title={t('table.viewProfile')}>
                      <SeatBadge
                        name={nameOf(s.seat)}
                        count={game?.handCounts[s.seat] ?? 0}
                        team={room.type === '2v2' ? s.team : null}
                        isTurn={game?.turn === s.seat}
                        connected={s.connected}
                        finished={finishedSet.has(s.seat)}
                        passed={passedSet.has(s.seat)}
                        lastPlayer={game?.pileOwner === s.seat}
                        partner={room.type === '2v2' && myTeam !== null && s.team === myTeam}
                      />
                    </button>
                  </div>
                );
              })}

            {/* Centre pile (above the betting ring + logo) */}
            <div className={`absolute inset-0 grid place-items-center z-[3]${finishFx ? ' finish-pop' : ''}`}>
              <Pile pile={game?.pile ?? null} />
            </div>
          </div>
          </div>
        </div>
      </div>

      {/* My hand + controls (no framing box — cards sit on the table surface) */}
      <div className="tv-bottom pt-1">
        {switching ? (
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
        ) : (
          <>
            {mySeat !== null && bubbleFor(mySeat) && (
              <div className="text-center pb-1">
                <span className="inline-block animate-pop panel-solid rounded-xl px-3 py-1 max-w-[220px] truncate">
                  {bubbleFor(mySeat)!.kind === 'emote'
                    ? <span className="text-xl leading-none">{bubbleFor(mySeat)!.text}</span>
                    : <span className="text-sm text-txt">{bubbleFor(mySeat)!.text}</span>}
                </span>
              </div>
            )}
            {isMyTurn && (
              <div className="text-center pb-1">
                <span className="inline-block animate-pop gold-text font-display font-semibold tracking-wide text-sm">{t('table.yourTurn')}</span>
              </div>
            )}
          </>
        )}
        <Hand cards={myHand} selected={switching ? (switchPick ? [cardKey(switchPick)] : []) : selected} onToggle={onCardTap} eligibleIds={eligibleSwitchIds} dealAnimate />
        {!switching && (
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
        )}
      </div>

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
          <div className="panel-solid w-full max-w-sm p-7 text-center animate-pop">
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

            <button autoFocus onClick={() => { sound.play('button'); void rematch(); }} className="btn btn-gold btn-lg btn-block">
              {t('table.playAgain')}
            </button>
            <button onClick={() => { dismissResult(); void leaveRoom(); }} className="btn btn-ghost btn-block mt-2">
              {t('table.returnLobby')}
            </button>

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
          <div className="panel-solid w-full max-w-sm p-6 text-center animate-pop">
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
