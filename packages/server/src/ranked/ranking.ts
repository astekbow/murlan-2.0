// ============================================================================
// MURLAN — Ranked rating math (pure, zero-dependency)
// ----------------------------------------------------------------------------
// MMR is a competitive/cosmetic number ONLY — it is NEVER cashable and has no
// bearing on the money ledger, scoring, or the rules engine. This module is a
// pure function library (no I/O, no clock) so the formula is exhaustively unit
// testable and identical in-memory and on Postgres.
//
// Rating uses a standard Elo update. For multi-player tables (1v1v1, 2v2) each
// player is scored against the AVERAGE rating of their opponents — a well-known
// simplification that keeps a single winner gaining and the rest losing without
// requiring a pairwise round-robin. Money settlement is unaffected and atomic
// elsewhere; rating updates run isolated and fire-and-forget at match-end.
// ============================================================================

/** Starting rating for a brand-new player in a season. */
export const DEFAULT_RATING = 1000;

/** Elo K-factor: the maximum swing of a single even-rated result (±K/2). */
export const K_FACTOR = 32;

/** Ratings never drop below this floor (Elo is otherwise unbounded below). */
export const MIN_RATING = 0;

/** Rank tiers, ascending. `min` is the inclusive lower rating bound. Names are
 *  Albanian (the player-facing language); `key` is the stable enum used in data. */
export type TierKey = 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'master';

export interface Tier {
  key: TierKey;
  name: string;   // Albanian, player-facing
  min: number;    // inclusive lower rating bound
  color: string;  // hex, for the badge
  emoji: string;
}

// Default 1000 lands in Bronze, leaving clear headroom to climb.
export const TIERS: readonly Tier[] = [
  { key: 'bronze',   name: 'Bronz',         min: 0,    color: '#a97142', emoji: '🥉' },
  { key: 'silver',   name: 'Argjend',       min: 1200, color: '#b8c0c8', emoji: '🥈' },
  { key: 'gold',     name: 'Ar',            min: 1500, color: '#e4b51c', emoji: '🥇' },
  { key: 'platinum', name: 'Platin',        min: 1800, color: '#3fc7c7', emoji: '💠' },
  { key: 'diamond',  name: 'Diamant',       min: 2100, color: '#5fa8ff', emoji: '💎' },
  { key: 'master',   name: 'Murlan Master', min: 2500, color: '#c061ff', emoji: '👑' },
] as const;

/** The tier a rating falls into (the highest tier whose `min` it meets). */
export function tierFromRating(rating: number): Tier {
  let result: Tier = TIERS[0]!; // TIERS is non-empty; bronze min is 0 so always matches
  for (const t of TIERS) if (rating >= t.min) result = t;
  return result;
}

/** Expected score (win probability) of `rating` against `opponent` (Elo). */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/**
 * New rating for ONE player after a result, given the average rating of their
 * opponents. `won` ⇒ actual score 1, else 0. Rounded and floored at MIN_RATING.
 */
export function calculateNewRating(rating: number, opponentAvg: number, won: boolean, k = K_FACTOR): number {
  const expected = expectedScore(rating, opponentAvg);
  const delta = Math.round(k * ((won ? 1 : 0) - expected));
  return Math.max(MIN_RATING, rating + delta);
}

export interface RatedPlayer {
  rating: number;
  won: boolean;
}

/**
 * New ratings for every seat in a finished table. Each player is scored against
 * the mean rating of the OTHER players. Fewer than 2 players ⇒ unchanged (a
 * rating is only meaningful relative to an opponent).
 */
export function applyMatchRatings(players: readonly RatedPlayer[], k = K_FACTOR): number[] {
  const n = players.length;
  if (n < 2) return players.map((p) => p.rating);
  const total = players.reduce((sum, p) => sum + p.rating, 0);
  return players.map((p) => {
    const opponentAvg = (total - p.rating) / (n - 1); // mean of everyone else
    return calculateNewRating(p.rating, opponentAvg, p.won, k);
  });
}

/**
 * Soft season reset: pull a peak rating partway back toward DEFAULT_RATING so a
 * new season is competitive without erasing what a player earned. decay=1 keeps
 * the full peak; decay=0 resets to default. Defaults to a half pull.
 */
export function softReset(peakRating: number, decay = 0.5): number {
  const d = Math.min(1, Math.max(0, decay));
  return Math.max(MIN_RATING, Math.round(peakRating * d + DEFAULT_RATING * (1 - d)));
}
