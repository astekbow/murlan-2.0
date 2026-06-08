// ============================================================================
// MURLAN — Core Rules Engine
// ----------------------------------------------------------------------------
// This module is the single source of truth for the rules. It is PURE logic:
// no networking, no database, no randomness leaking in (deal() takes a seed/rng).
// The server runs this authoritatively; the client may import the SAME file to
// validate moves locally for instant UX. Never trust the client's verdict.
// ============================================================================

// ---------- Card model -------------------------------------------------------

export type Suit = 'S' | 'H' | 'D' | 'C'; // Spades, Hearts, Diamonds, Clubs
export type Rank = '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A' | '2';
export type JokerColor = 'black' | 'red';

export type Card =
  | { kind: 'standard'; rank: Rank; suit: Suit }
  | { kind: 'joker'; color: JokerColor };

// Stable string id for each card (handy for sets, transport, dedup).
export function cardId(c: Card): string {
  return c.kind === 'joker' ? `J-${c.color}` : `${c.rank}${c.suit}`;
}

// ---------- Two parallel orderings (the heart of this variant) ---------------

// (1) POWER order — used for SINGLE / PAIR / TRIPLE / BOMB.
//     3 < 4 < ... < K < A < 2 < blackJoker < redJoker
const POWER: Record<Rank, number> = {
  '3': 0, '4': 1, '5': 2, '6': 3, '7': 4, '8': 5, '9': 6,
  '10': 7, 'J': 8, 'Q': 9, 'K': 10, 'A': 11, '2': 12,
};
const JOKER_POWER: Record<JokerColor, number> = { black: 13, red: 14 };

export function singlePower(c: Card): number {
  return c.kind === 'joker' ? JOKER_POWER[c.color] : POWER[c.rank];
}

// (2) SEQUENCE order — used INSIDE straights (KOLOR / FLUSH).
//     Natural order where the Ace is flexible (low = 1 or high = 14) and the
//     2 is ONLY ever low (value 2). This is why J-Q-K-A-2 is illegal.
const SEQ: Record<Exclude<Rank, 'A'>, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13,
};

// ---------- Combination types ------------------------------------------------

export type ComboType = 'single' | 'pair' | 'triple' | 'kolor' | 'bomb' | 'flush';

export interface Combo {
  type: ComboType;
  cards: Card[];
  size: number;
  // For single/pair/triple/bomb: comparison key in POWER order.
  power?: number;
  // For kolor/flush: the top value of the chosen consecutive run (SEQ order).
  topSeq?: number;
}

// ---------- Straight detection (handles flexible Aces) -----------------------

// Returns the top value of a valid consecutive run, or null if not a straight.
// Tries every assignment of each Ace to {1, 14} so that A2345 and 10JQKA both
// work, as well as the rare full-span kolor that uses two different Aces.
function straightTop(cards: Card[]): number | null {
  if (cards.length < 5) return null;
  if (cards.some(c => c.kind === 'joker')) return null; // jokers never sequence

  const fixed: number[] = [];
  let aces = 0;
  for (const c of cards) {
    if (c.kind !== 'standard') return null;
    if (c.rank === 'A') aces++;
    else fixed.push(SEQ[c.rank]);
  }

  // Each Ace independently becomes 1 or 14; test all 2^aces combinations.
  for (let mask = 0; mask < (1 << aces); mask++) {
    const vals = [...fixed];
    for (let i = 0; i < aces; i++) vals.push((mask >> i) & 1 ? 14 : 1);
    vals.sort((a, b) => a - b);
    const distinct = new Set(vals).size === vals.length;
    const consecutive = vals.every((v, i) => i === 0 || v === vals[i - 1]! + 1); // i>0 ⇒ defined
    if (distinct && consecutive) return vals[vals.length - 1] ?? null;
  }
  return null;
}

function allSameRank(cards: Card[]): boolean {
  if (cards.some(c => c.kind === 'joker')) return false; // jokers can't group
  const r = (cards[0] as Extract<Card, { kind: 'standard' }>).rank;
  return cards.every(c => c.kind === 'standard' && c.rank === r);
}

function allSameSuit(cards: Card[]): boolean {
  if (cards.some(c => c.kind === 'joker')) return false;
  const s = (cards[0] as Extract<Card, { kind: 'standard' }>).suit;
  return cards.every(c => c.kind === 'standard' && c.suit === s);
}

// ---------- Identify a set of cards as a (valid) combo, or null --------------

export function identifyCombo(cards: Card[]): Combo | null {
  const n = cards.length;
  if (n === 0) return null;

  if (n === 1) {
    return { type: 'single', cards, size: 1, power: singlePower(cards[0]!) }; // n===1 ⇒ defined
  }
  if (n === 2) {
    if (!allSameRank(cards)) return null; // no joker pairs, no mixed pairs
    return { type: 'pair', cards, size: 2, power: POWER[(cards[0] as Extract<Card, { kind: 'standard' }>).rank] };
  }
  if (n === 3) {
    if (!allSameRank(cards)) return null;
    return { type: 'triple', cards, size: 3, power: POWER[(cards[0] as Extract<Card, { kind: 'standard' }>).rank] };
  }
  if (n === 4) {
    // 4 cards is ONLY a bomb (straights need >= 5).
    if (!allSameRank(cards)) return null;
    return { type: 'bomb', cards, size: 4, power: POWER[(cards[0] as Extract<Card, { kind: 'standard' }>).rank] };
  }

  // n >= 5  ->  must be a straight; same suit makes it a flush, else a kolor.
  const top = straightTop(cards);
  if (top === null) return null;
  return {
    type: allSameSuit(cards) ? 'flush' : 'kolor',
    cards,
    size: n,
    topSeq: top,
  };
}

// ---------- Beat logic -------------------------------------------------------
// Category strength when used as a "trump":
//   FLUSH beats everything (including BOMB).
//   BOMB  beats everything EXCEPT flush (and a higher bomb).
//   Otherwise a play must match the current combo's category.
//
// RUN LENGTH RULE (kolor + flush): a run is beaten ONLY by a run of the SAME
// length with a higher top card. A run of a DIFFERENT length — shorter OR longer
// — can never be played on it (you must match the length, just as you must match
// the category). A flush is still the ultimate trump over OTHER categories
// (bomb/kolor/…); the same-length rule applies only flush-vs-flush.

export function beats(candidate: Combo, current: Combo): boolean {
  // --- Flush: the ultimate trump over other categories ---
  if (candidate.type === 'flush') {
    if (current.type === 'flush') {
      if (candidate.size !== current.size) return false; // runs must match length
      return candidate.topSeq! > current.topSeq!;
    }
    return true; // beats bomb, kolor, triple, pair, single
  }

  // --- Bomb: trumps all except flush, and ranks against other bombs ---
  if (candidate.type === 'bomb') {
    if (current.type === 'flush') return false;
    if (current.type === 'bomb') return candidate.power! > current.power!;
    return true; // beats kolor, triple, pair, single
  }

  // --- Non-trump plays must be the same category as the current pile ---
  if (candidate.type !== current.type) return false;

  switch (candidate.type) {
    case 'single':
    case 'pair':
    case 'triple':
      return candidate.power! > current.power!;
    case 'kolor':
      if (candidate.size !== current.size) return false; // runs must match length
      return candidate.topSeq! > current.topSeq!;
    default:
      return false;
  }
}

// Validate a proposed play. `current` is null when the player is leading a trick.
// `code` is a stable, language-neutral rejection identifier (the client localizes it);
// `reason` remains the human (Albanian) sentence used as a fallback. Additive — the
// rules themselves are unchanged.
export interface PlayCheck { ok: boolean; combo?: Combo; reason?: string; code?: string }

export function validatePlay(cards: Card[], current: Combo | null): PlayCheck {
  const combo = identifyCombo(cards);
  if (!combo) return { ok: false, reason: 'Kjo nuk është një kombinim i vlefshëm.', code: 'invalid_combo' };
  if (!current) return { ok: true, combo }; // any valid combo may lead
  if (!beats(combo, current)) return { ok: false, combo, reason: 'Nuk e mund kombinimin aktual.', code: 'does_not_beat' };
  return { ok: true, combo };
}

// ---------- Deck & dealing ---------------------------------------------------

export function buildDeck(): Card[] {
  const ranks: Rank[] = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
  const suits: Suit[] = ['S', 'H', 'D', 'C'];
  const deck: Card[] = [];
  for (const s of suits) for (const r of ranks) deck.push({ kind: 'standard', rank: r, suit: s });
  deck.push({ kind: 'joker', color: 'black' });
  deck.push({ kind: 'joker', color: 'red' });
  return deck; // 54 cards
}

// Fisher–Yates using an injected RNG (so the server can use a provably-fair
// seed and the result is reproducible/auditable). Never use Math.random in prod.
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!; // i and j are in-bounds (0 <= j <= i < a.length)
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// Deal sizes by player count (54-card deck).
//   2 players  -> 18 / 18   (the remaining 18 cards stay UNDEALT / dead)
//   3 players  -> 18 / 18 / 18
//   4 players  -> 14 / 14 / 13 / 13
export function dealSizes(players: 2 | 3 | 4): number[] {
  if (players === 2) return [18, 18];
  if (players === 3) return [18, 18, 18];
  return [14, 14, 13, 13];
}

export function deal(players: 2 | 3 | 4, rng: () => number): Card[][] {
  const deck = shuffle(buildDeck(), rng);
  const sizes = dealSizes(players);
  const hands: Card[][] = [];
  let i = 0;
  for (const size of sizes) { hands.push(deck.slice(i, i + size)); i += size; }
  return hands;
}

// Index of the hand that must lead the very first game (holds the starting card).
// "3 maç" = three of SPADES (♠). Configurable, but defaults to spades.
export function firstLeaderIndex(hands: Card[][], startSuit: Suit = 'S'): number {
  for (let h = 0; h < hands.length; h++) {
    if (hands[h]?.some(c => c.kind === 'standard' && c.rank === '3' && c.suit === startSuit)) return h;
  }
  return 0;
}
