// ============================================================================
// MURLAN — Match scoring & helpers (Phase 3, pure logic)
// ----------------------------------------------------------------------------
// Per-game scoring by room type, cumulative target / tie-extension evaluation,
// and the primitives behind the loser↔winner card switch. PURE: no state, no
// randomness, no network. All card power comparisons defer to the engine.
// ============================================================================

import type { Card } from '@murlan/engine';
import { singlePower } from '@murlan/engine';
import type { Seat } from '../game/singleGame.ts';

// Switch-return eligibility (rank 3–10) is shared verbatim with the client.
export { isReturnEligible, eligibleReturnCards } from '@murlan/shared';

export type MatchType = '1v1' | '1v1v1' | '2v2';

export function playersForType(type: MatchType): 2 | 3 | 4 {
  if (type === '1v1') return 2;
  if (type === '1v1v1') return 3;
  return 4;
}

// Points awarded by finishing place (index 0 = 1st place), per room type.
const PLACE_POINTS: Record<MatchType, number[]> = {
  '1v1': [1, 0],
  '1v1v1': [2, 1, 0],
  '2v2': [3, 2, 1, 0],
};

/**
 * Per-seat points for one finished game.
 * `finishingOrder[0]` is 1st place, `finishingOrder[last]` is last place.
 */
export function gamePoints(type: MatchType, finishingOrder: Seat[]): number[] {
  const n = playersForType(type);
  if (finishingOrder.length !== n) {
    throw new Error(`finishingOrder length ${finishingOrder.length} != ${n} for ${type}`);
  }
  const scale = PLACE_POINTS[type];
  const pts = new Array<number>(n).fill(0);
  finishingOrder.forEach((seat, place) => {
    pts[seat] = scale[place] ?? 0;
  });
  return pts;
}

/** The two fixed teams for a 2v2 match: seats 0 & 2 vs 1 & 3 (teammates opposite). */
export const DEFAULT_TEAMS: [Seat[], Seat[]] = [[0, 2], [1, 3]];

export function teamOfSeat(seat: Seat, teams: [Seat[], Seat[]]): 0 | 1 {
  return teams[0].includes(seat) ? 0 : 1;
}

/** Sum a per-seat array into [team0, team1] totals. */
export function teamTotals(perSeat: number[], teams: [Seat[], Seat[]]): [number, number] {
  const sum = (group: Seat[]) => group.reduce((acc, s) => acc + (perSeat[s] ?? 0), 0);
  return [sum(teams[0]), sum(teams[1])];
}

// ---------- Match target & tie extension (spec §2.10) -----------------------

export interface MatchEvaluation {
  over: boolean;
  winnerSide: number | null; // index into sideScores (seat for 1v1/1v1v1, team for 2v2)
  newTarget: number;
  extended: boolean;
}

/**
 * Decide, after a game, whether the match is won or the target must be raised.
 * `sideScores` are cumulative per side (per-player for 1v1/1v1v1, per-team for 2v2).
 *   - Unique leader with score ≥ target  → match won.
 *   - Two-or-more leaders tied at ≥ target − 1 → raise target by 10.
 *   - Otherwise keep playing at the same target.
 */
export function evaluateMatch(sideScores: number[], target: number): MatchEvaluation {
  const maxVal = Math.max(...sideScores);
  const leaders = sideScores.filter((s) => s === maxVal).length;

  if (leaders === 1 && maxVal >= target) {
    return { over: true, winnerSide: sideScores.indexOf(maxVal), newTarget: target, extended: false };
  }
  if (leaders >= 2 && maxVal >= target - 1) {
    return { over: false, winnerSide: null, newTarget: target + 10, extended: true };
  }
  return { over: false, winnerSide: null, newTarget: target, extended: false };
}

// ---------- Card-switch primitives (spec §2.8) ------------------------------

/** Index of the single strongest card in a hand by POWER order (ties → first found). */
export function strongestIndexByPower(hand: readonly Card[]): number {
  if (hand.length === 0) throw new Error('empty hand has no strongest card');
  let best = 0;
  let bestPow = singlePower(hand[0]!); // non-empty (checked above)
  for (let i = 1; i < hand.length; i++) {
    const p = singlePower(hand[i]!); // i < length ⇒ in-bounds
    if (p > bestPow) {
      bestPow = p;
      best = i;
    }
  }
  return best;
}

