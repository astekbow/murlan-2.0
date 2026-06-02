// Cross-cutting rule predicates shared by server and client (single source of
// truth). Card power/combo logic lives in @murlan/engine; this is the small set
// of rules the UI also needs to mirror exactly.

import type { Card } from '@murlan/engine';

/** Ranks a winner may RETURN to the loser in the card switch (spec §2.8.2). */
export const SWITCH_RANKS: ReadonlySet<string> = new Set(['3', '4', '5', '6', '7', '8', '9', '10']);

/** A returnable card is a standard card of rank 3–10 (never J/Q/K/A/2 or a joker). */
export function isReturnEligible(card: Card): boolean {
  return card.kind === 'standard' && SWITCH_RANKS.has(card.rank);
}

/** All cards in a hand the winner may return to the loser. */
export function eligibleReturnCards(hand: readonly Card[]): Card[] {
  return hand.filter(isReturnEligible);
}
