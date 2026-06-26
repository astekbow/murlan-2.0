// ============================================================================
// MURLAN — VIP / loyalty tiers (status only)
// ----------------------------------------------------------------------------
// A player's VIP tier is derived from their LIFETIME STAKED VOLUME (the sum of
// their bet stakes in the immutable ledger — no separate counter to drift). Tiers
// are STATUS / LEVEL only — a badge that rises as you play. There is NO rake-back
// (the house keeps the full rake). Pure tier math (unit-tested) + a thin ledger read.
// ============================================================================

import type { VipTierInfo, VipStatusDTO } from '@murlan/shared';
import type { Transaction } from '../money/ledger.ts';

// Ascending; `minStakedCents` is the inclusive lower bound to reach the tier.
// `xpBoostBps` is a REAL VIP perk: a match-XP boost (1000 bps = +10%) — NO rake-back (owner choice).
export const VIP_TIERS: readonly VipTierInfo[] = [
  { key: 'standard', name: 'Standard',     minStakedCents: 0,          color: '#9aa0a6', xpBoostBps: 0 },
  { key: 'bronze',   name: 'Bronz VIP',    minStakedCents: 10_000,     color: '#a97142', xpBoostBps: 1000 },
  { key: 'silver',   name: 'Argjend VIP',  minStakedCents: 100_000,    color: '#b8c0c8', xpBoostBps: 2000 },
  { key: 'gold',     name: 'Ar VIP',       minStakedCents: 1_000_000,  color: '#e4b51c', xpBoostBps: 3500 },
  { key: 'diamond',  name: 'Diamant VIP',  minStakedCents: 5_000_000,  color: '#5fa8ff', xpBoostBps: 5000 },
] as const;

/** Match-XP multiplier for a tier (1.0 = no boost). E.g. diamond (5000 bps) → 1.5×. */
export function vipXpMultiplier(tier: VipTierInfo): number {
  return 1 + Math.max(0, tier.xpBoostBps) / 10_000;
}

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
  // Bounded DB aggregate of lifetime staked volume (audit M4). When present it's used instead of
  // scanning the whole ledger; absent (e.g. a tiny test stub) → fall back to stakedVolume(list).
  stakedVolumeCents?: (userId: string) => Promise<number>;
}

export class VipService {
  constructor(private readonly wallet: LedgerReader) {}

  tiers(): VipTierInfo[] {
    return [...VIP_TIERS];
  }

  async getStatus(userId: string): Promise<VipStatusDTO> {
    const stakedCents = this.wallet.stakedVolumeCents
      ? await this.wallet.stakedVolumeCents(userId)
      : stakedVolume(await this.wallet.listTransactions(userId));
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
