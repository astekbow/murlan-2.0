// ============================================================================
// MURLAN — Match orchestrator (Phase 3, pure logic)
// ----------------------------------------------------------------------------
// Ties a sequence of single games together into a match: leader selection,
// per-game scoring, cumulative target / tie-extension, and the loser↔winner
// card switch between games. PURE: no networking, no DB. Dealing is INJECTED
// (`deal`) so the same code serves production (provably-fair RNG, Phase 7) and
// deterministic tests. The server (Phase 4) drives this and broadcasts the
// public snapshot; per-seat hands are exposed only for private delivery.
// ============================================================================

import type { Card, Rank, Suit } from '@murlan/engine';
import { cardId } from '@murlan/engine';
import {
  SingleGame, type Seat, type GameEvent, type GameSnapshot,
} from '../game/singleGame.ts';
import {
  type MatchType, playersForType, gamePoints, teamTotals, evaluateMatch,
  strongestIndexByPower, isReturnEligible, eligibleReturnCards, DEFAULT_TEAMS,
} from './scoring.ts';

export type MatchState = 'playing' | 'awaitingSwitch' | 'matchOver';

export interface MatchOptions {
  type: MatchType;
  /** Deals a fresh game: returns one hand per seat. Injected for determinism. */
  deal: () => Card[][];
  startTarget?: number;            // default 21
  startSuit?: Suit;                // suit of the "3" that opens game 1; default ♠
  teams?: [Seat[], Seat[]];        // 2v2 only; default seats 0&2 vs 1&3
}

export type MatchEvent =
  | { kind: 'gameStarted'; index: number; leader: Seat }
  | {
      kind: 'gameScored';
      index: number;
      finishingOrder: Seat[];
      points: number[];            // per-seat for this game
      cumulative: number[];        // per-seat cumulative
      teamCumulative?: [number, number]; // 2v2 only
    }
  | { kind: 'targetExtended'; newTarget: number }
  | { kind: 'cardSwitchAuto'; loser: Seat; winner: Seat; card: Card }   // loser's strongest -> winner
  | { kind: 'awaitingSwitch'; winner: Seat; loser: Seat }               // winner must return a 3–10 card
  | { kind: 'cardSwitchReturn'; winner: Seat; loser: Seat; card: Card | null } // winner's 3–10 -> loser (null if none)
  | { kind: 'noSwap'; winner: Seat; loser: Seat }                       // loser holds BOTH jokers → no switch, winner leads
  | { kind: 'matchEnded'; winnerSide: number; winnerSeats: Seat[]; finalSideScores: number[] };

export interface MatchActionResult {
  ok: boolean;
  reason?: string;
  code?: string;          // stable, language-neutral rejection code (client localizes it)
  gameEvents: GameEvent[];
  matchEvents: MatchEvent[];
}

export interface MatchSnapshot {
  type: MatchType;
  state: MatchState;
  target: number;
  gameIndex: number;               // 0-based index of the current/last game
  cumulative: number[];            // per-seat
  teamCumulative?: [number, number];
  teams?: [Seat[], Seat[]];
  game: GameSnapshot | null;       // current single-game public view (null between games / over)
  lastFinishingOrder: Seat[] | null;
  pendingSwitch: { winner: Seat; loser: Seat } | null;
  matchWinner: { side: number; seats: Seat[] } | null;
  gone: Seat[];                    // seats whose player abandoned the match
}

const ok = (gameEvents: GameEvent[], matchEvents: MatchEvent[]): MatchActionResult =>
  ({ ok: true, gameEvents, matchEvents });
const fail = (reason: string, code?: string): MatchActionResult =>
  ({ ok: false, reason, code, gameEvents: [], matchEvents: [] });

export class Match {
  readonly type: MatchType;
  readonly numPlayers: number;
  readonly teams: [Seat[], Seat[]];
  private readonly dealHands: () => Card[][];
  private readonly startSuit: Suit;

  private target: number;
  private cumulative: number[];
  private state: MatchState;
  private gameIndex: number;
  private game: SingleGame | null;
  private lastFinishingOrder: Seat[] | null;
  private matchWinner: { side: number; seats: Seat[] } | null;
  // Seats whose player abandoned the match. They are re-applied to every freshly
  // dealt game (auto-passed, placed last) so the match can play on without them,
  // and they are EXCLUDED from winnerSeats so a quitter is never paid.
  private goneSeats: Set<Seat>;

  // Pending state while a game is being set up / awaiting the winner's return card.
  private pendingHands: Card[][] | null;
  private pendingWinner: Seat | null;
  private pendingLoser: Seat | null;
  // The card the loser just auto-gave the winner: the winner may NOT hand it
  // straight back (that would nullify the loser's penalty). Excluded from the
  // winner's eligible-return set and rejected in switchGive.
  private pendingReceivedId: string | null;

  constructor(opts: MatchOptions) {
    this.type = opts.type;
    this.numPlayers = playersForType(opts.type);
    this.teams = opts.teams ?? DEFAULT_TEAMS;
    this.dealHands = opts.deal;
    this.startSuit = opts.startSuit ?? 'S';
    this.target = opts.startTarget ?? 21;
    this.cumulative = new Array<number>(this.numPlayers).fill(0);
    this.state = 'playing';
    this.gameIndex = 0;
    this.game = null;
    this.lastFinishingOrder = null;
    this.matchWinner = null;
    this.pendingHands = null;
    this.pendingWinner = null;
    this.pendingLoser = null;
    this.pendingReceivedId = null;
    this.goneSeats = new Set();

    this.startFirstGame();
  }

  // ---------- Public reads ----------------------------------------------------

  get currentState(): MatchState {
    return this.state;
  }

  get currentTarget(): number {
    return this.target;
  }

  /** The current game (when one is in progress), for the server to forward to. */
  get currentGame(): SingleGame | null {
    return this.game;
  }

  /** Private hand for a seat — from the live game, or the pending deal between games. */
  handOf(seat: Seat): readonly Card[] {
    if (this.state === 'playing' && this.game) return this.game.handOf(seat);
    if (this.pendingHands) return this.pendingHands[seat] ?? [];
    return [];
  }

  /** While awaiting the switch, the cards the winner may return (rank 3–10),
   *  EXCLUDING the card the loser just gave them (can't be handed straight back). */
  eligibleReturnCardsForWinner(): Card[] {
    if (this.state !== 'awaitingSwitch' || this.pendingWinner === null || !this.pendingHands) return [];
    return eligibleReturnCards(this.pendingHands[this.pendingWinner] ?? []).filter((c) => cardId(c) !== this.pendingReceivedId);
  }

  snapshot(): MatchSnapshot {
    return {
      type: this.type,
      state: this.state,
      target: this.target,
      gameIndex: this.gameIndex,
      cumulative: [...this.cumulative],
      teamCumulative: this.type === '2v2' ? teamTotals(this.cumulative, this.teams) : undefined,
      teams: this.type === '2v2' ? this.teams : undefined,
      game: this.state === 'playing' && this.game ? this.game.snapshot() : null,
      lastFinishingOrder: this.lastFinishingOrder ? [...this.lastFinishingOrder] : null,
      pendingSwitch:
        this.state === 'awaitingSwitch' && this.pendingWinner !== null && this.pendingLoser !== null
          ? { winner: this.pendingWinner, loser: this.pendingLoser }
          : null,
      matchWinner: this.matchWinner ? { side: this.matchWinner.side, seats: [...this.matchWinner.seats] } : null,
      gone: [...this.goneSeats].sort((a, b) => a - b),
    };
  }

  // ---------- Public actions --------------------------------------------------

  play(seat: Seat, cards: Card[]): MatchActionResult {
    if (this.state !== 'playing' || !this.game) return fail('Nuk je në një lojë aktive.', 'not_in_match');
    const r = this.game.play(seat, cards);
    if (!r.ok) return { ok: false, reason: r.reason, code: r.code, gameEvents: [], matchEvents: [] };
    return ok(r.events, this.game.isOver ? this.onGameEnd() : []);
  }

  pass(seat: Seat): MatchActionResult {
    if (this.state !== 'playing' || !this.game) return fail('Nuk je në një lojë aktive.', 'not_in_match');
    const r = this.game.pass(seat);
    if (!r.ok) return { ok: false, reason: r.reason, code: r.code, gameEvents: [], matchEvents: [] };
    return ok(r.events, this.game.isOver ? this.onGameEnd() : []);
  }

  /** The winner returns one rank-3–10 card to the loser, completing the switch. */
  switchGive(seat: Seat, card: Card): MatchActionResult {
    if (this.state !== 'awaitingSwitch' || !this.pendingHands || this.pendingWinner === null || this.pendingLoser === null) {
      return fail('Nuk ka shkëmbim letre në pritje.', 'no_pending_switch');
    }
    if (seat !== this.pendingWinner) return fail('Vetëm fituesi zgjedh letrën që kthen.', 'not_switch_winner');
    if (!isReturnEligible(card)) return fail('Letra e kthyer duhet të jetë e rangut 3–10.', 'switch_rank');
    if (cardId(card) === this.pendingReceivedId) return fail('Nuk mund të kthesh të njëjtën letër që sapo more.', 'switch_same_card');
    // pendingHands is fully dealt (one entry per seat) and pendingWinner/Loser are
    // valid, non-null seats (checked above) → these index accesses are defined.
    const winnerHand = this.pendingHands[this.pendingWinner]!;
    const idx = winnerHand.findIndex((x) => cardId(x) === cardId(card));
    if (idx < 0) return fail('Nuk e ke këtë letër në dorë.', 'not_your_cards');

    const returned = winnerHand.splice(idx, 1)[0]!; // idx >= 0 ⇒ one element removed
    this.pendingHands[this.pendingLoser]!.push(returned);
    const matchEvents: MatchEvent[] = [
      { kind: 'cardSwitchReturn', winner: this.pendingWinner, loser: this.pendingLoser, card: returned },
    ];
    matchEvents.push(this.beginPendingGame(this.pendingLoser)); // the loser leads the next game
    return ok([], matchEvents);
  }

  /**
   * A player abandoned the match (left / disconnected past grace / idled out).
   * The match CONTINUES with that seat auto-passed and placed last every game,
   * UNLESS too few players remain for a contest:
   *   - 1v1 / 1v1v1: ≤1 player left → the lone survivor wins immediately.
   *   - 2v2: a whole team gone → the other team wins immediately.
   *   - everyone gone → the match ends with no winner (caller voids + refunds).
   * The quitter is EXCLUDED from winnerSeats here and in onGameEnd, so they can
   * never be paid. Idempotent. Returns the events to broadcast (and, when the
   * match ends, a `matchEnded` the server settles through the normal path).
   */
  forfeit(seat: Seat): MatchActionResult {
    if (this.state === 'matchOver') return fail('Ndeshja ka mbaruar.', 'match_over');
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.numPlayers) return fail('Vend i pavlefshëm.', 'bad_seat');
    if (this.goneSeats.has(seat)) return ok([], []); // already gone — idempotent

    this.goneSeats.add(seat);
    const remaining = this.remainingSeats();

    if (this.mustEndAfterForfeit()) {
      return ok([], this.endByForfeit(remaining));
    }

    // Non-terminal: keep playing without the quitter.
    const gameEvents: GameEvent[] = [];
    const matchEvents: MatchEvent[] = [];
    if (this.state === 'playing' && this.game) {
      gameEvents.push(...this.game.forfeitSeat(seat));
      if (this.game.isOver) matchEvents.push(...this.onGameEnd());
    } else if (this.state === 'awaitingSwitch') {
      matchEvents.push(...this.onSwitchForfeit(seat));
    }
    // (between games with no pending switch — pendingHands set but not begun —
    //  the seat is applied when beginPendingGame deals the next game.)
    return ok(gameEvents, matchEvents);
  }

  /** Seats whose player has NOT abandoned the match. */
  private remainingSeats(): Seat[] {
    const out: Seat[] = [];
    for (let s = 0; s < this.numPlayers; s++) if (!this.goneSeats.has(s)) out.push(s);
    return out;
  }

  /** Is the outcome already decided because too few players (or a whole 2v2 team) remain? */
  private mustEndAfterForfeit(): boolean {
    if (this.type === '2v2') {
      const t0 = this.teams[0].filter((s) => !this.goneSeats.has(s)).length;
      const t1 = this.teams[1].filter((s) => !this.goneSeats.has(s)).length;
      return t0 === 0 || t1 === 0; // a whole team gone (or both) → decided
    }
    return this.remainingSeats().length < 2; // 1v1 / 1v1v1: ≤1 player left → decided
  }

  /** End the match by forfeit: the surviving side wins (its PRESENT members split
   *  the pot); if everyone is gone there is no winner (winnerSeats empty → void). */
  private endByForfeit(remaining: Seat[]): MatchEvent[] {
    let winnerSide: number;
    let winnerSeats: Seat[];
    if (this.type === '2v2') {
      const t0 = this.teams[0].filter((s) => !this.goneSeats.has(s));
      const t1 = this.teams[1].filter((s) => !this.goneSeats.has(s));
      if (t0.length > 0 && t1.length === 0) { winnerSide = 0; winnerSeats = t0; }
      else if (t1.length > 0 && t0.length === 0) { winnerSide = 1; winnerSeats = t1; }
      else { winnerSide = -1; winnerSeats = []; } // both teams gone → void
    } else if (remaining.length === 1) {
      winnerSide = remaining[0]!; // per-seat side
      winnerSeats = [remaining[0]!];
    } else {
      winnerSide = -1; winnerSeats = []; // everyone gone → void
    }
    this.matchWinner = winnerSide >= 0 ? { side: winnerSide, seats: winnerSeats } : null;
    this.state = 'matchOver';
    this.game = null;
    return [{ kind: 'matchEnded', winnerSide, winnerSeats, finalSideScores: this.sideScores() }];
  }

  /** A forfeit arrived while waiting for the winner's card-switch return. */
  private onSwitchForfeit(seat: Seat): MatchEvent[] {
    // The winner who owes a return left → skip the return, begin the next game
    // (loser leads). The loser leaving is harmless (the winner still returns; the
    // gone loser is re-applied when the game begins). A third seat leaving applies
    // when the next game is dealt.
    if (seat === this.pendingWinner && this.pendingLoser !== null) {
      const loser = this.pendingLoser;
      return [
        { kind: 'cardSwitchReturn', winner: seat, loser, card: null },
        this.beginPendingGame(loser),
      ];
    }
    return [];
  }

  // ---------- Internals -------------------------------------------------------

  private startFirstGame(): void {
    const hands = this.dealHands();
    this.assertHandCount(hands);

    const { leader, openingCard } = this.firstGameOpening(hands);
    this.game = new SingleGame({
      numPlayers: this.numPlayers as 2 | 3 | 4,
      hands,
      leader,
      openingCard,
    });
    this.state = 'playing';
    this.gameIndex = 0;
  }

  /**
   * Game-1 opener: the holder of the LOWEST start-suit card present leads AND must
   * open with it — normally the 3♠. But in 1v1 only 36/54 cards are dealt, so the
   * 3♠ may be undealt; then the 4♠ opens, else the 5♠, and so on UP the ranks.
   * (Applies to the FIRST game only — from game 2 the loser leads with no opening
   * constraint.) If no start-suit card was dealt at all (vanishingly rare), seat 0
   * opens freely.
   */
  private firstGameOpening(hands: Card[][]): { leader: Seat; openingCard?: Card } {
    const RANKS: Rank[] = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
    for (const rank of RANKS) {
      const holder = hands.findIndex(
        (h) => h.some((c) => c.kind === 'standard' && c.rank === rank && c.suit === this.startSuit),
      );
      if (holder >= 0) return { leader: holder, openingCard: { kind: 'standard', rank, suit: this.startSuit } };
    }
    return { leader: 0 };
  }

  /** Score the just-finished game, then either end the match or prepare the next. */
  private onGameEnd(): MatchEvent[] {
    const events: MatchEvent[] = [];
    const finishingOrder = [...(this.game as SingleGame).order];
    this.lastFinishingOrder = finishingOrder;

    const points = gamePoints(this.type, finishingOrder);
    this.cumulative = this.cumulative.map((v, i) => v + (points[i] ?? 0));

    events.push({
      kind: 'gameScored',
      index: this.gameIndex,
      finishingOrder,
      points,
      cumulative: [...this.cumulative],
      teamCumulative: this.type === '2v2' ? teamTotals(this.cumulative, this.teams) : undefined,
    });

    const sideScores = this.sideScores();
    const evaln = evaluateMatch(sideScores, this.target);

    if (evaln.over && evaln.winnerSide !== null) {
      // Exclude any abandoned seat from the winners (a 2v2 team can win on its
      // present member's points alone — the quitter teammate is never paid).
      const winnerSeats = this.seatsOfSide(evaln.winnerSide).filter((s) => !this.goneSeats.has(s));
      this.matchWinner = { side: evaln.winnerSide, seats: winnerSeats };
      this.state = 'matchOver';
      this.game = null;
      events.push({
        kind: 'matchEnded',
        winnerSide: evaln.winnerSide,
        winnerSeats,
        finalSideScores: sideScores,
      });
      return events;
    }

    if (evaln.extended) {
      this.target = evaln.newTarget;
      events.push({ kind: 'targetExtended', newTarget: this.target });
    }

    // Prepare the next game: deal, then run the loser↔winner card switch.
    this.prepareNextGame(finishingOrder, events);
    return events;
  }

  /** Deal the next game and perform the automatic loser→winner give (spec §2.8.1). */
  private prepareNextGame(prevOrder: Seat[], events: MatchEvent[]): void {
    // prevOrder is a completed game's finishing order (every seat, non-empty), and
    // assertHandCount guarantees a full deal — so these indices are defined.
    const winner = prevOrder[0]!;
    const loser = prevOrder[prevOrder.length - 1]!;
    const hands = this.dealHands();
    this.assertHandCount(hands);

    this.pendingHands = hands;
    this.pendingWinner = winner;
    this.pendingLoser = loser;
    this.pendingReceivedId = null;
    this.gameIndex += 1;

    // If the loser abandoned the match there's no one to penalise → skip the card
    // switch entirely and the winner (always a present player — quitters finish
    // last) leads the next game. The gone seat is re-applied in beginPendingGame.
    if (this.goneSeats.has(loser)) {
      events.push(this.beginPendingGame(winner));
      return;
    }

    // NO-SWAP rule: if the loser was dealt BOTH jokers, the switch is cancelled
    // (they keep both jokers) and the WINNER leads the next game instead of the
    // loser. Surfaced to clients as a "no swap" banner.
    const loserJokers = hands[loser]!.filter((c) => c.kind === 'joker').length;
    if (loserJokers >= 2) {
      events.push({ kind: 'noSwap', winner, loser });
      events.push(this.beginPendingGame(winner)); // winner leads, no give/return
      return;
    }

    // Step 1 (automatic): the loser gives their single strongest card (POWER
    // order — possibly the red joker) to the winner.
    const loserHand = hands[loser]!;
    const strongIdx = strongestIndexByPower(loserHand);
    const strongest = loserHand.splice(strongIdx, 1)[0]!;
    hands[winner]!.push(strongest);
    events.push({ kind: 'cardSwitchAuto', loser, winner, card: strongest });
    this.pendingReceivedId = cardId(strongest); // can't be returned to the loser

    // Step 2: the winner chooses a rank-3–10 card to return — but NOT the card
    // just received. If they have no OTHER eligible card, skip the return.
    const eligible = eligibleReturnCards(hands[winner]!).filter((c) => cardId(c) !== this.pendingReceivedId);
    if (eligible.length === 0) {
      events.push({ kind: 'cardSwitchReturn', winner, loser, card: null });
      events.push(this.beginPendingGame(loser)); // the loser leads (normal)
    } else {
      this.state = 'awaitingSwitch';
      events.push({ kind: 'awaitingSwitch', winner, loser });
    }
  }

  /** Start the prepared game. `leader` is the loser after a normal switch, or the
   *  WINNER after a no-swap (loser held both jokers). */
  private beginPendingGame(leader: Seat): MatchEvent {
    const hands = this.pendingHands as Card[][];
    this.game = new SingleGame({
      numPlayers: this.numPlayers as 2 | 3 | 4,
      hands,
      leader,
      // No opening-card constraint after the first game.
    });
    this.state = 'playing';
    this.pendingHands = null;
    this.pendingWinner = null;
    this.pendingLoser = null;
    this.pendingReceivedId = null;
    // Re-apply abandonment to the freshly dealt game so quitters stay auto-passed
    // and last. (We continue only with ≥2 present players, so this never empties
    // the table.) If the intended leader had quit, the turn advances off them.
    for (const s of this.goneSeats) this.game.forfeitSeat(s);
    return { kind: 'gameStarted', index: this.gameIndex, leader: this.game.currentTurn ?? leader };
  }

  private sideScores(): number[] {
    return this.type === '2v2' ? teamTotals(this.cumulative, this.teams) : [...this.cumulative];
  }

  private seatsOfSide(side: number): Seat[] {
    return this.type === '2v2' ? [...(this.teams[side] ?? [])] : [side];
  }

  private assertHandCount(hands: Card[][]): void {
    if (hands.length !== this.numPlayers) {
      throw new Error(`dealer returned ${hands.length} hands, expected ${this.numPlayers}`);
    }
  }
}
