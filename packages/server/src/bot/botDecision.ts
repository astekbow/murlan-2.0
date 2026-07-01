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
  identifyCombo, beats, singlePower, cardId, buildDeck,
} from '@murlan/engine';
import { chooseBestMove } from './botSearch.ts';

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
  /** Every card already PLAYED this game (all seats). The Hard tier counts cards
   *  from this to know what's still out there. Omitted ⇒ no card memory. */
  seen?: Card[];

  // --- Full public game state (from the SingleGame snapshot). When present, the
  // Hard tier runs a determinized Monte-Carlo SEARCH instead of pure heuristics;
  // omitted ⇒ Hard uses its heuristic policy (e.g. in unit tests). ---
  /** This bot's seat index. */
  mySeat?: number;
  /** Number of seats in the game. */
  numPlayers?: number;
  /** Seat that owns the current pile (last to play), or null. */
  pileOwner?: number | null;
  /** Seats that have passed in the current trick. */
  passed?: number[];
  /** Seats still holding cards. */
  active?: boolean[];
  /** Cards remaining per seat (index = seat). */
  handCounts?: number[];
  /** Seats already finished this game, in finishing order. */
  finishingOrder?: number[];
  /** TEAM PLAY (2v2): this bot's PARTNER seat, or undefined in solo games. When set, the bot
   *  cooperates — it won't overtake the partner's winning card, and it sets a near-finished
   *  partner up to go out. Applies to EVERY tier (team support outranks raw solo skill). */
  partnerSeat?: number;
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

/** Cards NOT yet seen by the bot: the full deck minus its own hand minus everything
 *  played so far. In 3/4-player games these are exactly the opponents' cards; in a
 *  2-player game some are dead (undealt), so counting stays conservative — it never
 *  over-claims a card is safe. */
function unseenCards(hand: Card[], seen: Card[]): Card[] {
  const known = new Set([...hand, ...seen].map(cardId));
  return buildDeck().filter((c) => !known.has(cardId(c)));
}

/** Higher = a better UNLOAD lead: shed as many cards as possible (a 5-run beats a
 *  triple beats a pair beats a single), break ties toward the LOWEST cards, and
 *  never fracture a pair/triple just to throw one of its cards as a single. */
function unloadScore(c: Combo, hand: Card[]): number {
  let s = c.cards.length * 100 - playCost(c); // shed many cards, cheaply
  if (c.type === 'single') {
    const r = rankOf(c.cards[0]!);
    if (r && countRank(hand, r) > 1) s -= 50; // keep groups intact
  }
  return s;
}

/** The biggest cheap non-trump combo to unload (or a trump if that's all that remains). */
function bestUnload(plays: Combo[], hand: Card[]): Combo {
  const nonTrump = plays.filter((c) => !isTrump(c));
  const pool = nonTrump.length ? nonTrump : plays;
  return pool.reduce((a, b) => (unloadScore(b, hand) > unloadScore(a, hand) ? b : a));
}

/** The LOWEST single the bot can lead that no still-unseen single can out-rank — so
 *  leading it very likely keeps the lead (an opponent could only burn a bomb/flush
 *  on it). undefined if no such lock exists. */
function lockSingle(plays: Combo[], hand: Card[], seen: Card[]): Combo | undefined {
  const unseen = unseenCards(hand, seen);
  const safe = plays.filter(
    (c) => c.type === 'single' && !unseen.some((u) => singlePower(u) > singlePower(c.cards[0]!)),
  );
  if (safe.length === 0) return undefined;
  return safe.reduce((a, b) => (singlePower(a.cards[0]!) < singlePower(b.cards[0]!) ? a : b));
}

/** Search budgets. MEDIUM runs the base look-ahead search; HARD searches DEEPER (more
 *  determinizations + candidates) for stronger, lower-variance play. Bounded so a single
 *  decision stays event-loop-safe (it runs inside the bot's think-delay). */
const MEDIUM_BUDGET = { sims: 36, maxCandidates: 14 } as const;
const HARD_BUDGET = { sims: 64, maxCandidates: 16 } as const;

/** EASY brain (levelled up to the old Medium): efficient "book" play — lead the weakest cards
 *  without fracturing a group, respond with the cheapest winning non-trump, and hoard bombs/
 *  flushes. Solid fundamentals, NO look-ahead. (A go-out is already taken by the caller.) */
function efficientHeuristic(view: BotView, plays: Combo[], canPass: boolean): BotMove {
  const sorted = [...plays].sort((a, b) => playCost(a) - playCost(b));
  const cheapestNonTrump = sorted.find((c) => !isTrump(c));
  if (!view.pile) return { action: 'play', cards: (bestLead(plays, view.hand) ?? sorted[0]!).cards };
  if (cheapestNonTrump) return { action: 'play', cards: cheapestNonTrump.cards };
  if (canPass) return { action: 'pass' };
  return { action: 'play', cards: sorted[0]!.cards };
}

/** Endgame-aware heuristic — the fallback for Medium/Hard when the rich public state the search
 *  needs isn't present (e.g. unit tests). Card-counts, denies a near-finished opponent an easy
 *  lead, and spends a trump to STOP an opponent about to win rather than hoarding into a loss. */
function endgameHeuristic(view: BotView, plays: Combo[], canPass: boolean): BotMove {
  const sorted = [...plays].sort((a, b) => playCost(a) - playCost(b));
  const cheapestNonTrump = sorted.find((c) => !isTrump(c));
  const oppClose = view.opponentCounts.length > 0 && Math.min(...view.opponentCounts) <= 2;
  if (!view.pile) {
    if (oppClose) {
      const singles = plays.filter((c) => c.type === 'single' && !isTrump(c));
      if (singles.length > 0) {
        const strongest = singles.reduce((a, b) => (playCost(b) > playCost(a) ? b : a));
        return { action: 'play', cards: strongest.cards };
      }
    }
    if (view.seen && view.hand.length <= 8 && view.hand.length > 1) {
      const lock = lockSingle(plays, view.hand, view.seen);
      if (lock) return { action: 'play', cards: lock.cards };
    }
    return { action: 'play', cards: bestUnload(plays, view.hand).cards };
  }
  if (cheapestNonTrump) return { action: 'play', cards: cheapestNonTrump.cards };
  if (oppClose) return { action: 'play', cards: sorted[0]!.cards };
  if (canPass) return { action: 'pass' };
  return { action: 'play', cards: sorted[0]!.cards };
}

/**
 * TEAM PLAY (2v2): cooperate with the partner. Returns a move when a team rule fires, else null
 * (fall through to solo play). Owner spec:
 *   A — never overtake the partner: if they're WINNING the current trick (own the pile), don't
 *       beat their card — pass and let them keep it.
 *   B — set up a near-finished partner: when LEADING and the partner is on their LAST card, lead a
 *       LOW single so they can beat it and go out. Cunning guard: skip it if the opponent sitting
 *       right after us is ALSO about to finish (don't gift THEM the trick).
 * (A guaranteed go-out for THIS bot is taken by the caller first — finishing always helps the team.)
 */
function teamMove(view: BotView, plays: Combo[], canPass: boolean): BotMove | null {
  if (view.partnerSeat == null || view.handCounts == null || view.mySeat == null || view.numPlayers == null) return null;
  // Rule A — don't beat the partner.
  if (view.pile != null && view.pileOwner === view.partnerSeat && canPass) {
    return { action: 'pass' };
  }
  // Rule B — help the partner go out.
  if (view.pile == null && (view.handCounts[view.partnerSeat] ?? 99) <= 1) {
    const nextSeat = (view.mySeat + 1) % view.numPlayers;
    const nextOppNearOut = nextSeat !== view.partnerSeat && (view.handCounts[nextSeat] ?? 99) <= 1;
    if (!nextOppNearOut) {
      const singles = plays.filter((c) => c.type === 'single' && !isTrump(c));
      if (singles.length > 0) {
        const lowest = singles.reduce((a, b) => (playCost(a) < playCost(b) ? a : b));
        return { action: 'play', cards: lowest.cards };
      }
    }
  }
  return null;
}

/**
 * Choose a move for the given tier. Each tier is one level stronger than before, and ALL tiers
 * play as a TEAM in 2v2 (helping the partner OUTRANKS raw solo skill):
 *   easy   — efficient "book" play (weakest leads, cheapest wins, hoards trumps); no look-ahead.
 *   medium — look-ahead: determinized Monte-Carlo search (card counting + endgame control).
 *   hard   — the SAME search, DEEPER (more determinizations + candidates) => stronger + steadier.
 * A leader always plays; a responder may pass. Pure: identical (view, tier, rng) => identical move.
 */
export function decideBotMove(view: BotView, tier: BotTier, rng: () => number = Math.random): BotMove {
  const plays = enumerateLegalPlays(view.hand, view.pile, view.mustInclude);
  const canPass = view.canPass && view.pile !== null;
  if (plays.length === 0) return { action: 'pass' }; // only reachable when responding

  // A guaranteed go-out is always taken — finishing helps the bot AND (in 2v2) its team.
  const out = plays.find((c) => goesOut(c, view.hand.length));
  if (out) return { action: 'play', cards: out.cards };

  // TEAM PLAY takes precedence over solo skill (every tier).
  const team = teamMove(view, plays, canPass);
  if (team) return team;

  // ----- Solo skill by tier --------------------------------------------------
  if (tier === 'easy') return efficientHeuristic(view, plays, canPass);

  // Medium + Hard THINK AHEAD with the determinized Monte-Carlo search; Hard searches deeper.
  if (view.mySeat != null && view.numPlayers != null) {
    const searched = chooseBestMove(view, rng, tier === 'hard' ? HARD_BUDGET : MEDIUM_BUDGET);
    if (searched) return searched;
  }
  return endgameHeuristic(view, plays, canPass);
}
