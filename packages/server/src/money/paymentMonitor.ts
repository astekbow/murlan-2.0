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

import { BINANCE_WITHDRAW_FAILED, type BinanceWithdrawalStatus } from './binancePayout.ts';

export interface FailedWithdrawalDeps {
  list: () => Promise<BinanceWithdrawalStatus[]>;            // Binance withdraw history (OUR payouts, bare ids)
  findWithdrawal: (id: string) => Promise<{ userId: string; amountCents: number; status: string } | null>;
  reverse: (w: { id: string; userId: string; amountCents: number }) => Promise<void>; // idempotent credit-back
  markReversed: (id: string) => Promise<void>;              // flip the record completed → rejected (durable dedup)
  notify: (text: string) => Promise<void>;
}

/**
 * Detect auto-payouts that Binance ACCEPTED but then failed/cancelled/rejected
 * on-chain (no webhook exists) and refund the player.
 *
 * SOURCE OF TRUTH = the withdrawal RECORD STATUS (durable, survives restarts), NOT
 * an in-memory set: we only act on a 'completed' withdrawal, and markReversed flips
 * it to 'rejected' so it's skipped forever after — and excluded from the daily cap.
 * We CREDIT FIRST (idempotent on providerRef) then mark: if marking fails, the next
 * sweep safely re-credits (no double — idempotent) and retries the mark. Restores
 * EXACTLY what was debited (wd.amountCents), so the ledger reconciles.
 */
export async function reconcileFailedWithdrawals(deps: FailedWithdrawalDeps): Promise<number> {
  const records = await deps.list();
  let reversedCount = 0;
  for (const r of records) {
    if (!BINANCE_WITHDRAW_FAILED.has(r.status)) continue;
    const wd = await deps.findWithdrawal(r.withdrawOrderId);
    if (!wd || wd.status !== 'completed') continue; // not ours / already reversed (now 'rejected')
    await deps.reverse({ id: r.withdrawOrderId, userId: wd.userId, amountCents: wd.amountCents });
    await deps.markReversed(r.withdrawOrderId);
    await deps.notify(
      `🔴 <b>Tërheqje DËSHTOI në Binance</b>\n` +
      `ID: ${r.withdrawOrderId}\nShuma: <b>$${(wd.amountCents / 100).toFixed(2)}</b>\n` +
      `→ Lojtarit iu rikreditua balanca (paratë u kthyen te Binance-i yt).`,
    );
    reversedCount++;
  }
  return reversedCount;
}
