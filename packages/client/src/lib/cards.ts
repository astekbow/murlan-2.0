// Presentation helpers for cards (labels, colors). UI-agnostic; the few human
// labels (jokers, spelled-out suits) resolve through the i18n catalog.
import type { Card, Combo } from '@murlan/engine';
import { cardId, singlePower } from '@murlan/engine';
import { translate, useLangStore } from './i18n.ts';

const lc = (key: string) => translate(key, useLangStore.getState().lang);

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export const cardKey = cardId;

// Sequence value for laying a run out left-to-right (mirrors the engine's SEQ:
// 2 is only low; the Ace is flexible). Display-only — the rules ignore card order.
const SEQ: Record<string, number> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13,
};

/**
 * Order a combo's cards for DISPLAY so a played run reads in sequence instead of
 * the (arbitrary) order the player selected them. Runs (kolor/flush) sort by
 * sequence — Ace-low for A2345…, Ace-high for …10JQKA; everything else by power.
 */
export function sortComboForDisplay(combo: Combo): Card[] {
  if (combo.type !== 'kolor' && combo.type !== 'flush') {
    return [...combo.cards].sort((a, b) => singlePower(a) - singlePower(b));
  }
  // A run containing a '2' must be Ace-low (A2345…); otherwise an Ace sits high (…KA).
  const aceHigh = !combo.cards.some((card) => card.kind === 'standard' && card.rank === '2');
  const seqVal = (card: Card): number =>
    card.kind === 'joker' ? 99 : card.rank === 'A' ? (aceHigh ? 14 : 1) : SEQ[card.rank] ?? 0;
  return [...combo.cards].sort((a, b) => seqVal(a) - seqVal(b));
}

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
