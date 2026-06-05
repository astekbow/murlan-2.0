// Presentation helpers for cards (labels, colors). Pure & UI-agnostic.
import type { Card } from '@murlan/engine';
import { cardId } from '@murlan/engine';

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export const cardKey = cardId;

export function isRed(card: Card): boolean {
  return card.kind === 'joker' ? card.color === 'red' : card.suit === 'H' || card.suit === 'D';
}

export function suitSymbol(card: Card): string {
  return card.kind === 'joker' ? '★' : SUIT_SYMBOL[card.suit] ?? '?';
}

export function rankText(card: Card): string {
  return card.kind === 'joker' ? 'JK' : card.rank;
}

export function cardLabel(card: Card): string {
  return card.kind === 'joker'
    ? card.color === 'red' ? 'Joker i kuq' : 'Joker i zi'
    : `${card.rank}${SUIT_SYMBOL[card.suit] ?? ''}`;
}

// Screen-reader label: suit symbols (♠/♥…) read poorly, so spell the suit in
// Albanian (matches the UI language) for an accessible aria-label.
const SUIT_WORD: Record<string, string> = { S: 'spadë', H: 'kupë', D: 'karo', C: 'spathi' };
export function cardAriaLabel(card: Card): string {
  return card.kind === 'joker'
    ? card.color === 'red' ? 'Xhol i kuq' : 'Xhol i zi'
    : `${card.rank} ${SUIT_WORD[card.suit] ?? ''}`.trim();
}
