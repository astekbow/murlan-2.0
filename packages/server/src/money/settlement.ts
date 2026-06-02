// ============================================================================
// MURLAN — Stake / pot / rake settlement (Phase 6, pure integer-cents math)
// ----------------------------------------------------------------------------
// pot = stake × players. The house keeps floor(pot × rakeBps / 10000); the
// winning side takes the remainder (so the floor remainder is never lost). In
// 2v2 the take is split between the two teammates with any odd cent going to
// the first listed winner. Conservation: sum(payouts) + rake === pot, exactly.
// ============================================================================

import type { Seat } from '../game/singleGame.ts';

export interface Payout {
  seat: Seat;
  amountCents: number;
}

export interface Settlement {
  potCents: number;
  rakeCents: number;
  payouts: Payout[];
}

export function potCents(stakeCents: number, players: number): number {
  return stakeCents * players;
}

/**
 * Split a pot among the winning seats after taking rake.
 * `winnerSeats` is one seat (1v1, 1v1v1) or two teammates (2v2).
 */
export function computeSettlement(input: {
  potCents: number;
  rakeBps: number;
  winnerSeats: Seat[];
}): Settlement {
  const { potCents: pot, rakeBps, winnerSeats } = input;
  if (winnerSeats.length === 0) throw new Error('settlement requires at least one winner');
  if (!Number.isInteger(pot) || pot < 0) throw new Error('pot must be a non-negative integer');
  if (rakeBps < 0 || rakeBps > 10_000) throw new Error('rakeBps out of range');

  const rakeCents = Math.floor((pot * rakeBps) / 10_000);
  const take = pot - rakeCents;
  const n = winnerSeats.length;
  const base = Math.floor(take / n);
  const remainder = take - base * n; // distributed one cent at a time, in order

  const payouts: Payout[] = winnerSeats.map((seat, i) => ({
    seat,
    amountCents: base + (i < remainder ? 1 : 0),
  }));

  return { potCents: pot, rakeCents, payouts };
}
