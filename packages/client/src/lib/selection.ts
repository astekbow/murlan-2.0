// Client-side card selection + INSTANT move validation. Uses the exact same
// rules engine as the server (`validatePlay`) so feedback matches the
// authoritative verdict — the server still re-validates every move.

import type { Card, Combo } from '@murlan/engine';
import { validatePlay, cardId } from '@murlan/engine';

/** Toggle a card id in/out of the current selection. */
export function toggleCard(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Resolve selected card ids back to the Card objects, preserving hand order. */
export function selectedCards(hand: readonly Card[], selected: string[]): Card[] {
  const set = new Set(selected);
  return hand.filter((c) => set.has(cardId(c)));
}

export interface SelectionEval {
  ok: boolean;
  combo: Combo | null;
  reason: string | null; // Albanian, from the engine
}

/** Whether the current selection is a legal play against `pile` (null = leading). */
export function evaluateSelection(cards: Card[], pile: Combo | null): SelectionEval {
  if (cards.length === 0) return { ok: false, combo: null, reason: null };
  const res = validatePlay(cards, pile);
  return { ok: res.ok, combo: res.combo ?? null, reason: res.reason ?? null };
}
