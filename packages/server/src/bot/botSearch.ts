// ============================================================================
// MURLAN — Determinized Monte-Carlo bot search (the "Hard" brain)
// ----------------------------------------------------------------------------
// Heuristics only get you so far against a real player. This is the proven
// technique for hidden-information card games (a.k.a. Perfect-Information Monte
// Carlo / determinized search):
//
//   for each legal move I could make:
//     repeat N times:
//       DETERMINIZE — deal the unseen cards to opponents at random, matching
//                     their known hand sizes (card counting: unseen = full deck
//                     minus my hand minus everything already played);
//       apply my move, then PLAY OUT the rest of the game with a fast policy for
//                     every seat;
//       record what PLACE I finished (1st is best).
//     score the move by its average finishing place.
//   play the move with the best (lowest) average place.
//
// It cheats nothing: it only ever uses public information (my hand, the pile,
// each seat's card COUNT, and the cards already played) — opponents' actual
// cards are sampled, never read. Legality always goes through @murlan/engine, so
// a simulated move can never diverge from the real rules. Budgets are bounded so
// a decision can't stall the event loop; on any problem the caller falls back to
// the heuristic policy.
// ============================================================================

import {
  type Card, type Combo, type Rank,
  identifyCombo, beats, singlePower, cardId, buildDeck, shuffle,
} from '@murlan/engine';
import type { BotMove, BotView } from './botDecision.ts';

// Tunables — sized from a benchmark to balance strength vs a synchronous event-loop
// blip: ~24 sims × 14 candidates keeps a full 18-card decision around ~15-20ms, and
// it runs inside the bot's think-delay. More sims ⇒ lower variance ⇒ stronger play,
// with diminishing returns (the cheap rollout is the real ceiling).
const SIMS_PER_MOVE = 24;   // determinizations evaluated per candidate move
const MAX_CANDIDATES = 14;  // candidate moves actually simulated (prefiltered)
const PLAYOUT_GUARD = 400;  // hard cap on rollout steps (safety against a stuck loop)

const SEQ: Record<Exclude<Rank, 'A'>, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
};
const std = (h: Card[]) => h.filter((c): c is Extract<Card, { kind: 'standard' }> => c.kind === 'standard');

// ---------- Candidate generation (root) -------------------------------------
// Full move set INCLUDING straights, so the bot considers its runs/flushes.

function groupPlays(hand: Card[]): Card[][] {
  const byRank = new Map<Rank, Extract<Card, { kind: 'standard' }>[]>();
  for (const c of std(hand)) { const l = byRank.get(c.rank) ?? []; l.push(c); byRank.set(c.rank, l); }
  const out: Card[][] = [];
  for (const cards of byRank.values()) {
    if (cards.length >= 2) out.push(cards.slice(0, 2));
    if (cards.length >= 3) out.push(cards.slice(0, 3));
    if (cards.length >= 4) out.push(cards.slice(0, 4));
  }
  return out;
}

function straightPlays(hand: Card[]): Card[][] {
  const out: Card[][] = [];
  const scan = (cards: Extract<Card, { kind: 'standard' }>[]) => {
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
        for (let v = start; v < start + len; v++) { const card = at.get(v); if (!card) { ok = false; break; } picked.push(card); }
        if (ok && new Set(picked.map(cardId)).size === picked.length) out.push(picked);
      }
    }
  };
  scan(std(hand));
  for (const suit of ['S', 'H', 'D', 'C'] as const) scan(std(hand).filter((c) => c.suit === suit));
  return out;
}

function rootPlays(hand: Card[], pile: Combo | null, mustInclude?: Card): Combo[] {
  const raw: Card[][] = [...hand.map((c) => [c]), ...groupPlays(hand), ...straightPlays(hand)];
  const seen = new Set<string>();
  const out: Combo[] = [];
  for (const cards of raw) {
    const key = cards.map(cardId).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const combo = identifyCombo(cards);
    if (!combo) continue;
    if (pile && !beats(combo, pile)) continue;
    out.push(combo);
  }
  if (mustInclude) {
    const id = cardId(mustInclude);
    return out.filter((c) => c.cards.some((card) => cardId(card) === id));
  }
  return out;
}

// ---------- Simulation state + the rules loop (mirrors SingleGame) -----------

interface Sim {
  n: number;
  hands: Card[][];
  active: boolean[];
  passed: boolean[];
  pile: Combo | null;
  owner: number | null;
  turn: number | null;
  order: number[]; // finishing order (seats), in finish sequence
}

function removeCards(hand: Card[], cards: Card[]): Card[] {
  const drop = new Set(cards.map(cardId));
  return hand.filter((c) => !drop.has(cardId(c)));
}
function activeCount(sim: Sim): number { return sim.active.reduce((n, a) => n + (a ? 1 : 0), 0); }
function nextActiveAfter(sim: Sim, from: number): number | null {
  for (let step = 1; step <= sim.n; step++) { const s = (from + step) % sim.n; if (sim.active[s]) return s; }
  return null;
}
function nextEligible(sim: Sim, from: number): number | null {
  for (let step = 1; step <= sim.n; step++) { const s = (from + step) % sim.n; if (sim.active[s] && !sim.passed[s]) return s; }
  return null;
}
function contendersExcludingOwner(sim: Sim): number {
  let c = 0;
  for (let s = 0; s < sim.n; s++) { if (s === sim.owner) continue; if (sim.active[s] && !sim.passed[s]) c++; }
  return c;
}
function endGame(sim: Sim): void {
  for (let s = 0; s < sim.n; s++) if (sim.active[s]) { sim.active[s] = false; sim.order.push(s); }
  sim.turn = null;
}
function resolveTrick(sim: Sim): void {
  const winner = sim.owner;
  let leadsNext: number | null;
  if (winner !== null && sim.active[winner]) leadsNext = winner;
  else if (winner !== null) leadsNext = nextActiveAfter(sim, winner);
  else leadsNext = null;
  sim.pile = null; sim.owner = null; sim.passed = new Array(sim.n).fill(false); sim.turn = leadsNext;
  if (leadsNext === null || activeCount(sim) <= 1) endGame(sim);
}
function afterAction(sim: Sim, seat: number): void {
  if (contendersExcludingOwner(sim) === 0) resolveTrick(sim);
  else { const nx = nextEligible(sim, seat); sim.turn = nx; if (nx === null) resolveTrick(sim); }
}
function applyPlay(sim: Sim, seat: number, combo: Combo): void {
  sim.hands[seat] = removeCards(sim.hands[seat]!, combo.cards);
  sim.pile = combo; sim.owner = seat;
  if (sim.hands[seat]!.length === 0) {
    sim.active[seat] = false; sim.order.push(seat);
    if (activeCount(sim) <= 1) { endGame(sim); return; }
  }
  afterAction(sim, seat);
}
function applyPass(sim: Sim, seat: number): void { sim.passed[seat] = true; afterAction(sim, seat); }

// ---------- Fast rollout policy (cheap; no straight enumeration) -------------
// Leading: shed the lowest single (keeps rollouts fast + consistent). Responding:
// the lowest same-category play that beats the pile, else pass. Trumps are left
// alone in rollouts (a small, consistent simplification).

function lowestSingle(hand: Card[]): Card {
  return hand.reduce((a, b) => (singlePower(b) < singlePower(a) ? b : a));
}
function rolloutPlay(sim: Sim, seat: number): Card[] | null {
  const hand = sim.hands[seat]!;
  const pile = sim.pile;
  if (!pile) return [lowestSingle(hand)]; // leading
  // Responding: match the pile category cheaply.
  if (pile.type === 'single') {
    let best: Card | null = null;
    for (const c of hand) if (singlePower(c) > pile.power! && (!best || singlePower(c) < singlePower(best))) best = c;
    return best ? [best] : null;
  }
  if (pile.type === 'pair' || pile.type === 'triple') {
    const need = pile.size;
    const byRank = new Map<Rank, Extract<Card, { kind: 'standard' }>[]>();
    for (const c of std(hand)) { const l = byRank.get(c.rank) ?? []; l.push(c); byRank.set(c.rank, l); }
    let best: { cards: Card[]; power: number } | null = null;
    for (const cards of byRank.values()) {
      if (cards.length < need) continue;
      const combo = identifyCombo(cards.slice(0, need));
      if (combo && beats(combo, pile) && (!best || combo.power! < best.power)) best = { cards: combo.cards, power: combo.power! };
    }
    return best ? best.cards : null;
  }
  // kolor/flush/bomb in a rollout: pass (consistent simplification — keeps it fast).
  return null;
}
function rolloutStep(sim: Sim, seat: number): void {
  const hand = sim.hands[seat]!;
  // Always go out if a single empties the hand or a group does (cheap check first).
  if (hand.length === 1 && (sim.pile === null || (sim.pile.type === 'single' && singlePower(hand[0]!) > sim.pile.power!))) {
    applyPlay(sim, seat, identifyCombo(hand)!);
    return;
  }
  const cards = rolloutPlay(sim, seat);
  if (cards) {
    const combo = identifyCombo(cards);
    if (combo) { applyPlay(sim, seat, combo); return; }
  }
  applyPass(sim, seat); // can only happen while responding
}

/** Play `sim` to completion (or until `mySeat` finishes) and return mySeat's PLACE. */
function playoutPlace(sim: Sim, mySeat: number): number {
  let guard = 0;
  while (sim.turn !== null && sim.active[mySeat] && guard++ < PLAYOUT_GUARD) {
    rolloutStep(sim, sim.turn);
  }
  const idx = sim.order.indexOf(mySeat);
  return idx >= 0 ? idx + 1 : sim.n; // not finished ⇒ worst place
}

// ---------- Determinization --------------------------------------------------

function unseen(view: BotView): Card[] {
  const known = new Set([...view.hand, ...(view.seen ?? [])].map(cardId));
  return buildDeck().filter((c) => !known.has(cardId(c)));
}

function determinize(view: BotView, pool: Card[], rng: () => number): Sim {
  const n = view.numPlayers!;
  const bag = shuffle(pool, rng);
  const hands: Card[][] = [];
  let i = 0;
  for (let s = 0; s < n; s++) {
    if (s === view.mySeat) { hands[s] = [...view.hand]; continue; }
    if (!(view.active?.[s] ?? true)) { hands[s] = []; continue; }
    const cnt = view.handCounts?.[s] ?? 0;
    hands[s] = bag.slice(i, i + cnt); i += cnt;
  }
  return {
    n,
    hands,
    active: view.active ? [...view.active] : hands.map((h) => h.length > 0),
    passed: boolFromSeats(view.passed ?? [], n),
    pile: view.pile,
    owner: view.pileOwner ?? null,
    turn: view.mySeat ?? 0,
    order: [...(view.finishingOrder ?? [])],
  };
}
function boolFromSeats(seats: number[], n: number): boolean[] {
  const b = new Array(n).fill(false);
  for (const s of seats) if (s >= 0 && s < n) b[s] = true;
  return b;
}

// ---------- Candidate prefilter ---------------------------------------------
// Cap how many moves we simulate. Always keep any go-out; otherwise prefer moves
// that shed more cards (bigger combos) at lower cost, plus the pass option.

function candidateScore(c: Combo, handSize: number): number {
  if (c.cards.length === handSize) return 1e9; // a go-out — always evaluate
  const top = c.type === 'kolor' || c.type === 'flush' ? (c.topSeq ?? 0) : (c.power ?? singlePower(c.cards[0]!));
  const trump = c.type === 'bomb' || c.type === 'flush' ? 1000 : 0;
  return c.cards.length * 100 - top - trump; // shed more, cheaper, keep trumps
}

// ---------- Public entry -----------------------------------------------------

/**
 * Choose the bot's move by determinized Monte-Carlo search. Returns null when the
 * needed public state isn't present (caller should fall back to the heuristic).
 */
export function chooseBestMove(
  view: BotView,
  rng: () => number = Math.random,
  opts: { sims?: number; maxCandidates?: number } = {},
): BotMove | null {
  if (view.mySeat == null || view.numPlayers == null) return null; // no rich context → fall back
  const plays = rootPlays(view.hand, view.pile, view.mustInclude);
  const canPass = view.canPass && view.pile !== null;
  if (plays.length === 0) return canPass ? { action: 'pass' } : null;

  // A guaranteed win is never worth searching past.
  const out = plays.find((c) => c.cards.length === view.hand.length);
  if (out) return { action: 'play', cards: out.cards };

  type Cand = { move: BotMove; combo: Combo | null };
  const ranked = [...plays].sort((a, b) => candidateScore(b, view.hand.length) - candidateScore(a, view.hand.length));
  const cands: Cand[] = ranked.slice(0, opts.maxCandidates ?? MAX_CANDIDATES).map((c) => ({ move: { action: 'play', cards: c.cards }, combo: c }));
  if (canPass) cands.push({ move: { action: 'pass' }, combo: null });
  if (cands.length === 1) return cands[0]!.move;

  const pool = unseen(view);
  const sims = opts.sims ?? SIMS_PER_MOVE;
  let best: Cand | null = null;
  let bestScore = Infinity;
  for (const cand of cands) {
    let total = 0;
    for (let s = 0; s < sims; s++) {
      const sim = determinize(view, pool, rng);
      if (cand.combo) applyPlay(sim, view.mySeat, cand.combo);
      else applyPass(sim, view.mySeat);
      total += playoutPlace(sim, view.mySeat);
    }
    const avg = total / sims;
    if (avg < bestScore) { bestScore = avg; best = cand; }
  }
  return best ? best.move : null;
}

export const _searchInternals = { rootPlays, determinize, playoutPlace, unseen }; // for tests
