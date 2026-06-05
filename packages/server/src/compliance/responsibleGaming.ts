// ============================================================================
// MURLAN — Responsible-gaming limits (deposit + loss caps)
// ----------------------------------------------------------------------------
// Player-set daily caps, enforced at the real-money entry points: a deposit cap
// (checked when creating a deposit) and a loss cap (checked at staked-match start,
// alongside the compliance gate). Sums are derived from the immutable ledger so
// they can't be gamed. Cents + UTC days throughout. The summation is pure (and
// unit-tested); the service just wires the user repo + the ledger.
// ============================================================================

import type { UserRepository } from '../auth/userRepository.ts';
import type { Transaction } from './../money/ledger.ts';

const DAY_MS = 86_400_000;
const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);

/**
 * Total of deposits made on the same UTC day as `now`. `excludeRef` skips a row
 * with that providerRef — used by the atomic credit-time cap check so a RETRIED
 * webhook (whose deposit row is already in the ledger) isn't double-counted.
 */
export function depositsToday(txs: readonly Transaction[], now: number, excludeRef?: string | null): number {
  const today = dayIndex(now);
  let sum = 0;
  for (const t of txs) {
    if (t.type !== 'deposit' || dayIndex(t.createdAt) !== today) continue;
    if (excludeRef && t.providerRef === excludeRef) continue;
    sum += t.amountCents;
  }
  return sum;
}

/**
 * Net gambling result on the same UTC day as `now`: bets are negative (debits),
 * payouts positive (credits). A negative total is a net loss. Rake is the house's
 * and never appears in a player's ledger, so it isn't counted.
 */
export function netResultToday(txs: readonly Transaction[], now: number): number {
  const today = dayIndex(now);
  let sum = 0;
  for (const t of txs) if ((t.type === 'bet' || t.type === 'payout') && dayIndex(t.createdAt) === today) sum += t.amountCents;
  return sum;
}

export interface RgLimits {
  dailyDepositLimitCents: number | null;
  dailyLossLimitCents: number | null;
}
export interface RgResult {
  allowed: boolean;
  code?: string;
  message?: string; // Albanian, player-facing
}
const ALLOWED: RgResult = { allowed: true };

interface LedgerReader {
  listTransactions: (userId: string) => Promise<Transaction[]>;
}

export class ResponsibleGamingService {
  constructor(
    private readonly users: UserRepository,
    private readonly wallet: LedgerReader, // WalletService.listTransactions
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getLimits(userId: string): Promise<RgLimits> {
    const u = await this.users.findById(userId);
    return {
      dailyDepositLimitCents: u?.dailyDepositLimitCents ?? null,
      dailyLossLimitCents: u?.dailyLossLimitCents ?? null,
    };
  }

  /**
   * Set/clear limits. A limit must be a POSITIVE integer-cent cap; null — and any
   * non-positive / non-finite value — means "no limit" (clears it). This avoids the
   * footgun where a 0 cap silently blocks everything (a 0 loss cap would block all
   * staked play, since net 0 ≤ −0).
   */
  async setLimits(userId: string, patch: Partial<RgLimits>): Promise<RgLimits> {
    const norm = (v: number | null | undefined): number | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null || !Number.isFinite(v) || v <= 0) return null;
      return Math.floor(v);
    };
    await this.users.setLimits(userId, {
      dailyDepositLimitCents: norm(patch.dailyDepositLimitCents),
      dailyLossLimitCents: norm(patch.dailyLossLimitCents),
    });
    return this.getLimits(userId);
  }

  /** Block a deposit that would push today's deposits over the daily cap. */
  async checkDeposit(userId: string, amountCents: number): Promise<RgResult> {
    const { dailyDepositLimitCents: limit } = await this.getLimits(userId);
    if (limit === null) return ALLOWED;
    const used = depositsToday(await this.wallet.listTransactions(userId), this.now());
    if (used + amountCents > limit) {
      return { allowed: false, code: 'deposit_limit', message: 'Kufiri ditor i depozitës u arrit.' };
    }
    return ALLOWED;
  }

  /** Block starting a staked match once today's net loss has reached the cap. */
  async checkLoss(userId: string): Promise<RgResult> {
    const { dailyLossLimitCents: limit } = await this.getLimits(userId);
    if (limit === null) return ALLOWED;
    const net = netResultToday(await this.wallet.listTransactions(userId), this.now());
    if (net <= -limit) {
      return { allowed: false, code: 'loss_limit', message: 'Kufiri ditor i humbjes u arrit.' };
    }
    return ALLOWED;
  }
}
