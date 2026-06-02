// Socket payload validation. The client is UNTRUSTED: every intent payload is
// validated at the gateway boundary BEFORE it reaches the engine, so a malformed
// message (missing field, wrong type, garbage card) is rejected with an ack —
// never thrown deep inside removeCards()/validatePlay() where the throw would
// escape the handler and leave the client's ack hanging until it times out.

import type { Card } from '@murlan/engine';
import { PLAYERS_PER_TYPE, type MatchType } from '@murlan/shared';

const RANKS: ReadonlySet<string> = new Set(['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']);
const SUITS: ReadonlySet<string> = new Set(['S', 'H', 'D', 'C']);

/** A play can never legally exceed a full deck; bounds the validation loop. */
const MAX_CARDS_PER_PLAY = 54;

/** Stake bounds (cents). 0 = free table; cap guards against absurd/typo stakes. */
export const MIN_STAKE_CENTS = 0;
export const MAX_STAKE_CENTS = 1_000_000; // $10,000

export function isValidCard(x: unknown): x is Card {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  if (c.kind === 'standard') return typeof c.rank === 'string' && RANKS.has(c.rank) && typeof c.suit === 'string' && SUITS.has(c.suit);
  if (c.kind === 'joker') return c.color === 'black' || c.color === 'red';
  return false;
}

export function isCardArray(x: unknown): x is Card[] {
  return Array.isArray(x) && x.length > 0 && x.length <= MAX_CARDS_PER_PLAY && x.every(isValidCard);
}

export function isMatchType(x: unknown): x is MatchType {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PLAYERS_PER_TYPE, x);
}

export function isTeam(x: unknown): x is 0 | 1 | undefined {
  return x === undefined || x === 0 || x === 1;
}

export function isValidStake(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= MIN_STAKE_CENTS && x <= MAX_STAKE_CENTS;
}

export function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0 && x.length <= 200;
}
