// ============================================================================
// MURLAN — VIP / loyalty tiers (status only)
// ----------------------------------------------------------------------------
// A player's VIP tier is derived from their LIFETIME STAKED VOLUME (the sum of
// their bet stakes in the immutable ledger — no separate counter to drift). Tiers
// confer status (a badge) and a rake-back RATE; the actual rake-back CASHOUT is a
// real-money payout and stays payment-gated (deferred), so this surfaces the rate
// but never pays it. Pure tier math (unit-tested) + a thin ledger read.
// ============================================================================

import type { VipTierInfo, VipStatusDTO } from '@murlan/shared';
import type { Transaction } from '../money/ledger.ts';

// Ascending; `minStakedCents` is the inclusive lower bound to reach the tier.
export const VIP_TIERS: readonly VipTierInfo[] = [
  { key: 'standard', name: 'Standard',     minStakedCents: 0,          rakebackBps: 0,   color: '#9aa0a6' },
  { key: 'bronze',   name: 'Bronz VIP',    minStakedCents: 10_000,     rakebackBps: 50,  color: '#a97142' },
  { key: 'silver',   name: 'Argjend VIP',  minStakedCents: 100_000,    rakebackBps: 100, color: '#b8c0c8' },
  { key: 'gold',     name: 'Ar VIP',       minStakedCents: 1_000_000,  rakebackBps: 200, color: '#e4b51c' },
  { key: 'diamond',  name: 'Diamant VIP',  minStakedCents: 5_000_000,  rakebackBps: 300, color: '#5fa8ff' },
] as const;

/** Lifetime staked volume = the magnitude of all 'bet' debits in the ledger. */
export function stakedVolume(txs: readonly Transaction[]): number {
  let sum = 0;
  for (const t of txs) if (t.type === 'bet') sum += Math.abs(t.amountCents);
  return sum;
}

/** The VIP tier a staked volume reaches (highest tier whose min it meets). */
export function vipTierFor(stakedCents: number): VipTierInfo {
  let result: VipTierInfo = VIP_TIERS[0]!; // standard min is 0 → always matches
  for (const t of VIP_TIERS) if (stakedCents >= t.minStakedCents) result = t;
  return result;
}

interface LedgerReader {
  listTransactions: (userId: string) => Promise<Transaction[]>;
}

export class VipService {
  constructor(private readonly wallet: LedgerReader) {}

  tiers(): VipTierInfo[] {
    return [...VIP_TIERS];
  }

  async getStatus(userId: string): Promise<VipStatusDTO> {
    const stakedCents = stakedVolume(await this.wallet.listTransactions(userId));
    const tier = vipTierFor(stakedCents);
    const idx = VIP_TIERS.findIndex((t) => t.key === tier.key);
    const next = idx >= 0 && idx < VIP_TIERS.length - 1 ? VIP_TIERS[idx + 1]! : null;
    return {
      stakedCents,
      tier,
      next,
      toNextCents: next ? Math.max(0, next.minStakedCents - stakedCents) : 0,
    };
  }
}
