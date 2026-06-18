// ============================================================================
// MURLAN — Single-Game State Machine (Phase 2)
// ----------------------------------------------------------------------------
// Drives ONE game from a dealt set of hands through tricks/passes to a full
// finishing order. PURE logic: no networking, no DB, no randomness. All move
// legality is delegated to the rules engine (`@murlan/engine`) — this module
// never reinvents combination or comparison logic.
//
// The server uses this authoritatively. It exposes hands via `handOf(seat)` so
// the server can send each player only their own cards; the broadcast snapshot
// (`snapshot()`) carries only public information (counts, the current pile,
// whose turn, finishing order) and never leaks hidden cards.
// ============================================================================

import type { Card, Combo } from '@murlan/engine';
import { cardId, validatePlay } from '@murlan/engine';

export type Seat = number; // 0-based seat index

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

/** Human-readable card label for player-facing messages (e.g. "3♠", "Joker i kuq"). */
export function describeCard(card: Card): string {
  return card.kind === 'joker'
    ? card.color === 'red' ? 'Joker i kuq' : 'Joker i zi'
    : `${card.rank}${SUIT_SYMBOL[card.suit] ?? card.suit}`;
}

export type GameStatus = 'playing' | 'finished';

// ---------- Actions a player may take ----------------------------------------

export type Action =
  | { type: 'play'; seat: Seat; cards: Card[] }
  | { type: 'pass'; seat: Seat };

// ---------- Events emitted by applying an action -----------------------------
// The server maps these onto Socket.IO events; tests assert on them directly.

export type GameEvent =
  | { kind: 'played'; seat: Seat; combo: Combo }
  | { kind: 'passed'; seat: Seat }
  | { kind: 'trickWon'; winner: Seat; leadsNext: Seat | null } // leadsNext null only if game ended
  | { kind: 'playerFinished'; seat: Seat; place: number }       // place is 1-based
  | { kind: 'gameEnded'; finishingOrder: Seat[] };              // full order, length === numPlayers

export interface ActionResult {
  ok: boolean;
  reason?: string;        // Albanian, player-facing, on failure
  code?: string;          // stable, language-neutral rejection code (client localizes it)
  events: GameEvent[];
}

// ---------- Public, broadcast-safe snapshot (NO hidden cards) ----------------

export interface GameSnapshot {
  numPlayers: number;
  status: GameStatus;
  turn: Seat | null;            // whose turn; null when finished
  pile: Combo | null;           // the combo currently on the table to beat
  pileOwner: Seat | null;       // who owns the pile (the last player who played)
  handCounts: number[];         // cards remaining per seat (public)
  active: boolean[];            // seats that still hold cards
  passed: Seat[];               // seats that have passed in the current trick
  finishingOrder: Seat[];       // seats in the order they emptied their hands
  gone: Seat[];                 // seats whose player abandoned (auto-passed, placed last)
  // The card the opening lead MUST include (e.g. 3♠ in game 1), or null once the
  // game has opened / when there is no opening constraint. Public info — lets the
  // timeout forced-lead lead it explicitly instead of relying on power ordering.
  openingCard: Card | null;
}

export interface GameOptions {
  numPlayers: 2 | 3 | 4;
  hands: Card[][];   // hands[seat] — exactly `numPlayers` entries
  leader: Seat;      // seat that leads the first trick (e.g. holder of 3♠, or previous loser)
  // If set, the very first (opening) play of the game MUST include this card.
  // Used for the first game of a match, where the opening lead must contain 3♠.
  openingCard?: Card;
}

export class SingleGame {
  readonly numPlayers: number;
  private hands: Card[][];
  private active: boolean[];
  private passed: Set<Seat>;
  private finishingOrder: Seat[];
  // Seats whose player abandoned the match. They auto-pass (never act) and are
  // placed LAST in the finishing order (see endGame), so a quitter can never
  // profit. Insertion order = abandon order (earliest-gone ranks most-last).
  private gone: Set<Seat>;
  private pile: Combo | null;
  private pileOwner: Seat | null;
  private turn: Seat | null;
  private status: GameStatus;
  private readonly openingCard: Card | null;
  private opened: boolean; // becomes true after the first successful play of the game

  constructor(opts: GameOptions) {
    const { numPlayers, hands, leader } = opts;
    if (hands.length !== numPlayers) {
      throw new Error(`expected ${numPlayers} hands, got ${hands.length}`);
    }
    if (leader < 0 || leader >= numPlayers) {
      throw new Error(`leader ${leader} out of range`);
    }
    this.numPlayers = numPlayers;
    this.hands = hands.map((h) => [...h]);
    this.active = hands.map((h) => h.length > 0);
    this.passed = new Set();
    this.finishingOrder = [];
    this.gone = new Set();
    this.pile = null;
    this.pileOwner = null;
    this.turn = leader;
    this.status = 'playing';
    this.openingCard = opts.openingCard ?? null;
    this.opened = false;

    // A leader with no cards is nonsensical; advance to the first seat that has any.
    if (!this.active[leader]) {
      const next = this.nextActiveAfter(leader);
      this.turn = next;
      if (next === null) this.status = 'finished';
    }
  }

  // ---------- Read access -----------------------------------------------------

  /** The private hand for a seat (server-only; never broadcast wholesale). */
  handOf(seat: Seat): readonly Card[] {
    return this.hands[seat] ?? [];
  }

  /** The combo currently on the table, or null when leading a fresh trick. */
  currentPile(): Combo | null {
    return this.pile;
  }

  get currentTurn(): Seat | null {
    return this.turn;
  }

  get isOver(): boolean {
    return this.status === 'finished';
  }

  /** Finishing order so far; complete (length === numPlayers) once the game ends. */
  get order(): readonly Seat[] {
    return this.finishingOrder;
  }

  /** Broadcast-safe public view — contains NO hidden card identities. */
  snapshot(): GameSnapshot {
    return {
      numPlayers: this.numPlayers,
      status: this.status,
      turn: this.turn,
      pile: this.pile,
      pileOwner: this.pileOwner,
      handCounts: this.hands.map((h) => h.length),
      active: [...this.active],
      passed: [...this.passed].sort((a, b) => a - b),
      finishingOrder: [...this.finishingOrder],
      gone: [...this.gone].sort((a, b) => a - b),
      openingCard: this.opened ? null : this.openingCard,
    };
  }

  // ---------- Public action API ----------------------------------------------

  apply(action: Action): ActionResult {
    return action.type === 'play'
      ? this.play(action.seat, action.cards)
      : this.pass(action.seat);
  }

  play(seat: Seat, cards: Card[]): ActionResult {
    const events: GameEvent[] = [];
    if (this.status === 'finished') return fail('Loja ka mbaruar.', 'game_over');
    if (seat !== this.turn) return fail('Nuk është radha jote.', 'not_your_turn');
    if (cards.length === 0) return fail('Duhet të luash të paktën një letër.', 'no_cards_selected');

    // Ownership: every played card must be in the player's hand, with no repeats.
    if (!this.handHasAll(seat, cards)) return fail('Nuk i ke këto letra në dorë.', 'not_your_cards');

    // Opening rule: the very first play of the game must include the opening
    // card when one is configured (the first game of a match: 3♠).
    if (this.openingCard && !this.opened) {
      const openId = cardId(this.openingCard);
      if (!cards.some((x) => cardId(x) === openId)) {
        return fail(`Hapja e parë duhet të përfshijë letrën ${describeCard(this.openingCard)}.`, 'must_open');
      }
    }

    // Legality: delegate entirely to the rules engine (leading => current is null).
    const check = validatePlay(cards, this.pile);
    if (!check.ok || !check.combo) return fail(check.reason ?? 'Lëvizje e palejuar.', check.code ?? 'illegal');

    // Commit the play.
    this.removeCards(seat, cards);
    this.pile = check.combo;
    this.pileOwner = seat;
    this.opened = true;
    events.push({ kind: 'played', seat, combo: check.combo });

    // Did this empty the player's hand?
    if (this.hands[seat]!.length === 0) { // seat is the acting player ⇒ in-bounds
      this.active[seat] = false;
      this.finishingOrder.push(seat);
      events.push({ kind: 'playerFinished', seat, place: this.finishingOrder.length });

      // Game ends the moment only one player still holds cards.
      if (this.activeCount() <= 1) {
        this.endGame(events);
        return ok(events);
      }
    }

    this.afterAction(seat, events);
    return ok(events);

    function fail(reason: string, code?: string): ActionResult {
      return { ok: false, reason, code, events: [] };
    }
    function ok(evts: GameEvent[]): ActionResult {
      return { ok: true, events: evts };
    }
  }

  pass(seat: Seat): ActionResult {
    const events: GameEvent[] = [];
    if (this.status === 'finished') return { ok: false, reason: 'Loja ka mbaruar.', code: 'game_over', events: [] };
    if (seat !== this.turn) return { ok: false, reason: 'Nuk është radha jote.', code: 'not_your_turn', events: [] };
    // You may only pass when there is something to beat; the leader must play.
    if (this.pile === null) {
      return { ok: false, reason: 'Nuk mund të pasosh kur je i pari në dorë.', code: 'cannot_pass_leading', events: [] };
    }

    this.passed.add(seat);
    events.push({ kind: 'passed', seat });
    this.afterAction(seat, events);
    return { ok: true, events };
  }

  /**
   * Remove a seat from the game because its player abandoned the match. The seat
   * is deactivated (auto-passes for the rest of THIS game) and recorded as `gone`
   * so endGame places it LAST — a quitter can never finish ahead of a player who
   * stayed. Idempotent; safe to call on a seat that already finished (it just
   * keeps the place it earned). If it was the gone seat's turn, play advances
   * (resolving the trick if no one is left to contest it). The caller decides
   * whether the MATCH should end (too few players left) BEFORE calling this — see
   * Match.forfeit; here we only end the single game when ≤1 seat still holds cards.
   */
  forfeitSeat(seat: Seat): GameEvent[] {
    const events: GameEvent[] = [];
    if (this.status === 'finished') return events;
    if (seat < 0 || seat >= this.numPlayers) return events;
    if (this.gone.has(seat)) return events; // already abandoned
    this.gone.add(seat);
    if (!this.active[seat]) return events; // already emptied their hand — keep their place

    this.active[seat] = false;
    this.passed.delete(seat);
    const wasTurn = this.turn === seat;

    if (wasTurn) {
      if (this.pile === null) {
        // They were leading a fresh trick → the lead passes to the next holder.
        const next = this.nextActiveAfter(seat);
        this.turn = next;
        if (next === null) this.endGame(events);
      } else {
        // They owed a response → mirror a pass: resolve if no contender remains.
        if (this.contendersExcludingOwner().length === 0) this.resolveTrick(events);
        else this.turn = this.nextEligible(seat);
      }
    }
    // Removing a player can leave only one holder of cards → end the game.
    // (`isOver` re-reads status, which resolveTrick/endGame above may have flipped.)
    if (!this.isOver && this.activeCount() <= 1) this.endGame(events);
    return events;
  }

  // ---------- Internals -------------------------------------------------------

  /**
   * Shared post-action handling: either the trick is won (all other active
   * players have passed) or play advances to the next eligible seat.
   */
  private afterAction(seat: Seat, events: GameEvent[]): void {
    // Contenders = active seats that have NOT passed this trick, excluding the
    // pile owner. When none remain, the owner has taken the trick.
    const contenders = this.contendersExcludingOwner();
    if (contenders.length === 0) {
      this.resolveTrick(events);
    } else {
      const next = this.nextEligible(seat);
      // `next` is guaranteed non-null here because contenders is non-empty.
      this.turn = next;
    }
  }

  /** Resolve a won trick: the owner takes it; the lead passes appropriately. */
  private resolveTrick(events: GameEvent[]): void {
    const winner = this.pileOwner;
    // The owner leads the next trick — unless they just finished, in which case
    // the lead passes to the next player in seat order who still holds cards.
    let leadsNext: Seat | null;
    if (winner !== null && this.active[winner]) {
      leadsNext = winner;
    } else if (winner !== null) {
      leadsNext = this.nextActiveAfter(winner);
    } else {
      leadsNext = null;
    }

    // Clear the table for a fresh trick.
    this.pile = null;
    this.pileOwner = null;
    this.passed.clear();
    this.turn = leadsNext;

    events.push({ kind: 'trickWon', winner: winner ?? -1, leadsNext });

    // Defensive: if no one can lead (only one active left), end the game.
    if (leadsNext === null || this.activeCount() <= 1) {
      this.endGame(events);
    }
  }

  /** Conclude the game: append the lone remaining player, then any abandoned
   *  seats LAST (worst places). Among abandoned seats, the earliest to leave
   *  ranks most-last, so we append them in reverse abandon order. */
  private endGame(events: GameEvent[]): void {
    if (this.status === 'finished') return;
    // Players who still hold cards but didn't abandon: appended in seat order
    // (normally just the single last holder once activeCount hit 1).
    for (let s = 0; s < this.numPlayers; s++) {
      if (this.active[s] && !this.gone.has(s)) {
        this.active[s] = false;
        this.finishingOrder.push(s);
      }
    }
    // Abandoned seats fill the remaining (worst) places. Reverse insertion order
    // ⇒ the first player to quit ends up at the very bottom.
    const goneList = [...this.gone];
    for (let i = goneList.length - 1; i >= 0; i--) {
      const s = goneList[i]!;
      if (!this.finishingOrder.includes(s)) this.finishingOrder.push(s);
    }
    this.status = 'finished';
    this.turn = null;
    this.pile = null;
    this.pileOwner = null;
    this.passed.clear();
    events.push({ kind: 'gameEnded', finishingOrder: [...this.finishingOrder] });
  }

  private contendersExcludingOwner(): Seat[] {
    const out: Seat[] = [];
    for (let s = 0; s < this.numPlayers; s++) {
      if (s === this.pileOwner) continue;
      if (this.active[s] && !this.passed.has(s)) out.push(s);
    }
    return out;
  }

  /** Next seat after `from` that is active and has not passed this trick. */
  private nextEligible(from: Seat): Seat | null {
    for (let step = 1; step <= this.numPlayers; step++) {
      const s = (from + step) % this.numPlayers;
      if (this.active[s] && !this.passed.has(s)) return s;
    }
    return null;
  }

  /** Next seat after `from` that is still active (ignores passes — new trick). */
  private nextActiveAfter(from: Seat): Seat | null {
    for (let step = 1; step <= this.numPlayers; step++) {
      const s = (from + step) % this.numPlayers;
      if (this.active[s]) return s;
    }
    return null;
  }

  private activeCount(): number {
    return this.active.reduce((n, a) => n + (a ? 1 : 0), 0);
  }

  private handHasAll(seat: Seat, cards: Card[]): boolean {
    const handIds = new Set(this.hands[seat]!.map(cardId)); // hands has one entry per seat
    const seen = new Set<string>();
    for (const card of cards) {
      const id = cardId(card);
      if (seen.has(id)) return false;   // same physical card listed twice
      seen.add(id);
      if (!handIds.has(id)) return false;
    }
    return true;
  }

  private removeCards(seat: Seat, cards: Card[]): void {
    const remove = new Set(cards.map(cardId));
    this.hands[seat] = this.hands[seat]!.filter((c) => !remove.has(cardId(c)));
  }
}

// ---------- Convenience factory ---------------------------------------------

export function startGame(opts: GameOptions): SingleGame {
  return new SingleGame(opts);
}
