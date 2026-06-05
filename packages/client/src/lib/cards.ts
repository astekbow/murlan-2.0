// Presentation helpers for cards (labels, colors). UI-agnostic; the few human
// labels (jokers, spelled-out suits) resolve through the i18n catalog.
import type { Card } from '@murlan/engine';
import { cardId } from '@murlan/engine';
import { translate, useLangStore } from './i18n.ts';

const lc = (key: string) => translate(key, useLangStore.getState().lang);

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
    ? lc(card.color === 'red' ? 'card.jokerRed' : 'card.jokerBlack')
    : `${card.rank}${SUIT_SYMBOL[card.suit] ?? ''}`;
}

// Screen-reader label: suit symbols (♠/♥…) read poorly, so spell the suit in the
// UI language for an accessible aria-label.
const SUIT_KEY: Record<string, string> = { S: 'card.suitS', H: 'card.suitH', D: 'card.suitD', C: 'card.suitC' };
export function cardAriaLabel(card: Card): string {
  return card.kind === 'joker'
    ? lc(card.color === 'red' ? 'card.ariaJokerRed' : 'card.ariaJokerBlack')
    : `${card.rank} ${SUIT_KEY[card.suit] ? lc(SUIT_KEY[card.suit]!) : ''}`.trim();
}
