// Pure helpers for the periodic payment-ops checks (no I/O → unit-testable).
//  • findStaleWithdrawals: manual withdrawals sitting unapproved too long.
//  • treasuryBufferCents: Binance free USDT minus what we owe players (negative =
//    under-funded → we can't cover all withdrawals).

export function findStaleWithdrawals<T extends { id: string; createdAt: number }>(
  pending: T[],
  now: number,
  thresholdMs: number,
  alerted: Set<string>,
): T[] {
  return pending.filter((w) => now - w.createdAt >= thresholdMs && !alerted.has(w.id));
}

/** Drop ids from the alerted set that are no longer pending (keeps it bounded). */
export function pruneAlerted(alerted: Set<string>, stillPendingIds: Iterable<string>): void {
  const live = new Set(stillPendingIds);
  for (const id of [...alerted]) if (!live.has(id)) alerted.delete(id);
}

/** Binance free USDT (cents) minus total player liabilities (cents). */
export function treasuryBufferCents(binanceUsdtCents: number, playerLiabilitiesCents: number): number {
  return binanceUsdtCents - playerLiabilitiesCents;
}
