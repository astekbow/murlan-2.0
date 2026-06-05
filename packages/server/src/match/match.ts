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

import type { Card, Suit } from '@murlan/engine';
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
    matchEvents.push(this.beginPendingGame());
    return ok([], matchEvents);
  }

  // ---------- Internals -------------------------------------------------------

  private startFirstGame(): void {
    const hands = this.dealHands();
    this.assertHandCount(hands);

    // First game: the holder of the start "3" (♠ by default) leads AND must open
    // with it. In 1v1 only 36/54 cards are dealt, so the 3♠ may be undealt — in
    // that case we fall back to seat 0 leading with a free opening.
    const holder = hands.findIndex(
      (h) => h.some((c) => c.kind === 'standard' && c.rank === '3' && c.suit === this.startSuit),
    );
    const leader = holder >= 0 ? holder : 0;
    const openingCard: Card | undefined =
      holder >= 0 ? { kind: 'standard', rank: '3', suit: this.startSuit } : undefined;

    this.game = new SingleGame({
      numPlayers: this.numPlayers as 2 | 3 | 4,
      hands,
      leader,
      openingCard,
    });
    this.state = 'playing';
    this.gameIndex = 0;
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
      const winnerSeats = this.seatsOfSide(evaln.winnerSide);
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

    // Step 1 (automatic): the loser gives their single strongest card (POWER
    // order — possibly the red joker) to the winner.
    const loserHand = hands[loser]!;
    const strongIdx = strongestIndexByPower(loserHand);
    const strongest = loserHand.splice(strongIdx, 1)[0]!;
    hands[winner]!.push(strongest);
    events.push({ kind: 'cardSwitchAuto', loser, winner, card: strongest });

    this.pendingHands = hands;
    this.pendingWinner = winner;
    this.pendingLoser = loser;
    this.pendingReceivedId = cardId(strongest); // can't be returned to the loser
    this.gameIndex += 1;

    // Step 2: the winner chooses a rank-3–10 card to return — but NOT the card
    // just received. If they have no OTHER eligible card, skip the return.
    const eligible = eligibleReturnCards(hands[winner]!).filter((c) => cardId(c) !== this.pendingReceivedId);
    if (eligible.length === 0) {
      events.push({ kind: 'cardSwitchReturn', winner, loser, card: null });
      events.push(this.beginPendingGame());
    } else {
      this.state = 'awaitingSwitch';
      events.push({ kind: 'awaitingSwitch', winner, loser });
    }
  }

  /** Start the prepared game; the loser (last place) of the previous game leads. */
  private beginPendingGame(): MatchEvent {
    const hands = this.pendingHands as Card[][];
    const leader = this.pendingLoser as Seat;
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
    return { kind: 'gameStarted', index: this.gameIndex, leader };
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
