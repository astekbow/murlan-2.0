// ============================================================================
// MURLAN — Bot opponent decision logic (pure, engine-backed)
// ----------------------------------------------------------------------------
// A stateless decision function for AI opponents. It NEVER reimplements the
// rules: legal plays are enumerated from the hand and validated through the SAME
// @murlan/engine primitives (identifyCombo / beats / validatePlay) the
// authoritative server uses, so a bot can only ever make a legal move.
//
// Bots are ONLY ever seated in zero-stake rooms (practice / table-fill / FTUE),
// so this code never touches money, the ledger, or settlement — it just chooses
// which legal play to make. Randomness is injected (rng) so the policies are
// deterministic under test; production passes Math.random.
//
// Straight (kolor/flush) enumeration is bounded and covers the common runs; a
// few exotic multi-Ace straights may be skipped (a bot simply won't choose
// them) — acceptable for an opponent and never produces an ILLEGAL move.
// ============================================================================

import {
  type Card, type Combo, type Rank,
  identifyCombo, beats, singlePower, cardId,
} from '@murlan/engine';

export type BotTier = 'easy' | 'medium' | 'hard';

export type BotMove = { action: 'play'; cards: Card[] } | { action: 'pass' };

export interface BotView {
  /** The bot's current hand. */
  hand: Card[];
  /** The pile to beat, or null when the bot is leading a fresh trick. */
  pile: Combo | null;
  /** False when leading (a leader must play; only a responder may pass). */
  canPass: boolean;
  /** Remaining card counts of the OTHER seats — used by the smarter tiers. */
  opponentCounts: number[];
  /** If set, the chosen play MUST contain this card (game-1 opening 3♠ rule). */
  mustInclude?: Card;
}

// SEQ value for straights: Ace is flexible (1 or 14), 2 is only low. Mirrors the
// engine's internal ordering; used purely to PROPOSE candidate runs, which are
// then confirmed by identifyCombo (the real authority).
const SEQ: Record<Exclude<Rank, 'A'>, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13,
};

function standardCards(hand: Card[]): Extract<Card, { kind: 'standard' }>[] {
  return hand.filter((c): c is Extract<Card, { kind: 'standard' }> => c.kind === 'standard');
}

/** One representative pair/triple/bomb per rank that has enough cards. */
function groupPlays(hand: Card[]): Card[][] {
  const byRank = new Map<Rank, Extract<Card, { kind: 'standard' }>[]>();
  for (const c of standardCards(hand)) {
    const list = byRank.get(c.rank) ?? [];
    list.push(c);
    byRank.set(c.rank, list);
  }
  const out: Card[][] = [];
  for (const cards of byRank.values()) {
    if (cards.length >= 2) out.push(cards.slice(0, 2)); // pair
    if (cards.length >= 3) out.push(cards.slice(0, 3)); // triple
    if (cards.length >= 4) out.push(cards.slice(0, 4)); // bomb
  }
  return out;
}

/** Candidate straights via a bounded consecutive-run scan (cross-suit = kolor,
 *  per-suit = flush). Each candidate is confirmed by identifyCombo downstream. */
function straightPlays(hand: Card[]): Card[][] {
  const out: Card[][] = [];
  const scan = (cards: Extract<Card, { kind: 'standard' }>[]) => {
    // value (1..14) -> first available card at that value (Ace fills 1 AND 14).
    const at = new Map<number, Extract<Card, { kind: 'standard' }>>();
    for (const c of cards) {
      if (c.rank === 'A') { if (!at.has(1)) at.set(1, c); if (!at.has(14)) at.set(14, c); }
      else if (!at.has(SEQ[c.rank])) at.set(SEQ[c.rank], c);
    }
    const maxLen = Math.min(cards.length, 13);
    for (let len = 5; len <= maxLen; len++) {
      for (let start = 1; start + len - 1 <= 14; start++) {
        const picked: Extract<Card, { kind: 'standard' }>[] = [];
        let ok = true;
        for (let v = start; v < start + len; v++) {
          const card = at.get(v);
          if (!card) { ok = false; break; }
          picked.push(card);
        }
        // Guard against reusing one physical Ace for both value 1 and 14.
        if (ok && new Set(picked.map(cardId)).size === picked.length) out.push(picked);
      }
    }
  };
  scan(standardCards(hand)); // kolors (and same-suit runs surface as flushes)
  for (const suit of ['S', 'H', 'D', 'C'] as const) {
    scan(standardCards(hand).filter((c) => c.suit === suit)); // flushes
  }
  return out;
}

/**
 * Every legal combo the bot could play right now: all singles + grouped
 * pairs/triples/bombs + bounded straights, validated by the engine and (when
 * responding) filtered to those that beat the pile. Deduped by card-set.
 */
export function enumerateLegalPlays(hand: Card[], pile: Combo | null, mustInclude?: Card): Combo[] {
  const raw: Card[][] = [
    ...hand.map((c) => [c]),       // singles (incl. jokers)
    ...groupPlays(hand),
    ...straightPlays(hand),
  ];
  const seen = new Set<string>();
  const out: Combo[] = [];
  for (const cards of raw) {
    const key = cards.map(cardId).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const combo = identifyCombo(cards);
    if (!combo) continue;
    if (pile && !beats(combo, pile)) continue; // responding: must beat the pile
    out.push(combo);
  }
  if (mustInclude) {
    const id = cardId(mustInclude);
    return out.filter((c) => c.cards.some((card) => cardId(card) === id));
  }
  return out;
}

const isTrump = (c: Combo) => c.type === 'bomb' || c.type === 'flush';

/** Sort key: cheaper (weaker) plays first; trumps (bomb/flush) sort last so the
 *  hoarding tiers keep them in reserve. */
function playCost(c: Combo): number {
  const base = c.type === 'kolor' || c.type === 'flush' ? (c.topSeq ?? 0) : (c.power ?? singlePower(c.cards[0]!));
  return (isTrump(c) ? 1000 : 0) + base;
}

const goesOut = (c: Combo, handSize: number) => c.cards.length === handSize;
const pick = <T>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)]!;

const rankOf = (c: Card): Rank | null => (c.kind === 'standard' ? c.rank : null);
function countRank(hand: Card[], rank: Rank): number {
  return hand.reduce((n, card) => (card.kind === 'standard' && card.rank === rank ? n + 1 : n), 0);
}

/**
 * Leading score (LOWER = a better lead): get rid of cheap cards first, thin the
 * hand (prefer plays that shed more cards), keep bombs/flushes in reserve, and
 * don't fracture a pair/triple just to throw one of its cards as a single.
 */
function leadScore(c: Combo, hand: Card[]): number {
  let s = playCost(c) - c.cards.length * 0.5; // cheaper + thins the hand
  if (isTrump(c)) s += 1000;                  // hoard trumps when leading
  if (c.type === 'single') {
    const r = rankOf(c.cards[0]!);
    if (r && countRank(hand, r) > 1) s += 40; // breaking a group for a single is wasteful
  }
  return s;
}

/** The best non-trump lead under leadScore, or undefined if only trumps remain. */
function bestLead(plays: Combo[], hand: Card[]): Combo | undefined {
  const opts = plays.filter((c) => !isTrump(c));
  if (opts.length === 0) return undefined;
  return opts.reduce((a, b) => (leadScore(b, hand) < leadScore(a, hand) ? b : a));
}

/**
 * Choose a move for the given tier. A leader (canPass=false) always plays — when
 * leading there is always at least one legal play (any single). A responder may
 * pass. Pure: identical (view, tier, rng) ⇒ identical move.
 *
 * The three tiers are deliberately distinct:
 *   easy   — erratic + wasteful: misses guaranteed wins, dumps its best cards
 *            early, and passes when it shouldn't. Made to be beaten.
 *   medium — efficient: always takes a go-out, leads its weakest cards (without
 *            fracturing combos), responds with the cheapest winning play, and
 *            hoards bombs/flushes.
 *   hard   — medium + endgame awareness: denies a nearly-finished opponent an
 *            easy lead by leading its strongest single, and spends a trump to
 *            stop an opponent about to win rather than hoarding into a loss.
 */
export function decideBotMove(view: BotView, tier: BotTier, rng: () => number = Math.random): BotMove {
  const plays = enumerateLegalPlays(view.hand, view.pile, view.mustInclude);
  const canPass = view.canPass && view.pile !== null;
  if (plays.length === 0) return { action: 'pass' }; // only reachable when responding

  // Medium/Hard never miss a guaranteed win (a play that empties the hand). Easy
  // does — that's part of what makes it easy.
  if (tier !== 'easy') {
    const out = plays.find((c) => goesOut(c, view.hand.length));
    if (out) return { action: 'play', cards: out.cards };
  }

  const sorted = [...plays].sort((a, b) => playCost(a) - playCost(b));
  const cheapestNonTrump = sorted.find((c) => !isTrump(c));
  const oppClose = view.opponentCounts.length > 0 && Math.min(...view.opponentCounts) <= 2;

  // ----- EASY ---------------------------------------------------------------
  if (tier === 'easy') {
    if (canPass && rng() < 0.4) return { action: 'pass' };                       // passes when it shouldn't
    if (rng() < 0.5) return { action: 'play', cards: pick(plays, rng).cards };   // random legal play
    return { action: 'play', cards: sorted[sorted.length - 1]!.cards };          // or wastes its strongest
  }

  // ----- MEDIUM -------------------------------------------------------------
  if (tier === 'medium') {
    if (!view.pile) return { action: 'play', cards: (bestLead(plays, view.hand) ?? sorted[0]!).cards };
    if (cheapestNonTrump) return { action: 'play', cards: cheapestNonTrump.cards };
    if (canPass) return { action: 'pass' };               // only trumps beat it → hoard while responding
    return { action: 'play', cards: sorted[0]!.cards };
  }

  // ----- HARD ---------------------------------------------------------------
  if (!view.pile) {
    // Deny a nearly-finished opponent an easy take: lead the STRONGEST non-trump
    // single so they can't cheaply grab the lead and go out.
    if (oppClose) {
      const singles = plays.filter((c) => c.type === 'single' && !isTrump(c));
      if (singles.length > 0) {
        const strongest = singles.reduce((a, b) => (playCost(b) > playCost(a) ? b : a));
        return { action: 'play', cards: strongest.cards };
      }
    }
    return { action: 'play', cards: (bestLead(plays, view.hand) ?? sorted[0]!).cards };
  }
  if (cheapestNonTrump) return { action: 'play', cards: cheapestNonTrump.cards };
  // Only trumps beat the pile: spend one to stop an opponent about to win, else hoard.
  if (oppClose) return { action: 'play', cards: sorted[0]!.cards };
  if (canPass) return { action: 'pass' };
  return { action: 'play', cards: sorted[0]!.cards };
}
