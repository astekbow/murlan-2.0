// Semi-automatic withdrawal triage (pure, no I/O). Classifies a withdrawal into
// a handling TIER so the operator can fast-track the safe ones:
//   • 'auto'   — small AND under the daily cap → safe to approve quickly
//   • 'manual' — large, over the daily cap, or the feature is off → review before paying
// KYC removed (owner decision): identity verification is no longer a condition for the
// auto tier. The amount threshold + per-user 24h cap remain the auto-pay safety rails.
//
// NOTE: this only decides the HANDLING tier and what the Telegram alert says. The
// actual crypto send is still performed by the operator (or, later, a configured
// payout provider) — nothing here moves money or marks a withdrawal paid.

export type WithdrawalTier = 'auto' | 'manual';

export interface WithdrawalClassification {
  tier: WithdrawalTier;
  reasons: string[]; // why it's manual (empty when auto)
}

export function classifyWithdrawal(
  // `kycStatus` is accepted but ignored (KYC removed) — kept in the shape so callers
  // and the Telegram alert payload don't need to change, and to ease re-enabling later.
  input: {
    amountCents: number;
    kycStatus?: string | null | undefined;
    priorTodayCents?: number;       // this user's other 24h withdrawals (per-user cap)
    globalTodayCents?: number;      // ALL users' auto-paid in 24h (money-7 global budget)
    destTodayCents?: number;        // auto-paid to THIS destination in 24h (money-7 per-dest cap)
    recentTransferInCents?: number; // P2P received in 24h (money-7: received funds → manual)
  },
  cfg: {
    autoMaxCents: number;
    dailyAutoCapCents?: number;     // per-user 24h cap (0 = off)
    globalAutoCapCents?: number;    // money-7 global 24h budget (0 = off)
    destAutoCapCents?: number;      // money-7 per-destination 24h cap (0 = off)
  },
): WithdrawalClassification {
  const reasons: string[] = [];
  if (cfg.autoMaxCents <= 0) {
    reasons.push('auto disabled');
  } else if (input.amountCents > cfg.autoMaxCents) {
    reasons.push('above auto threshold');
  }
  // Per-user 24h auto-payout cap (anti hot-wallet-drain / AML structuring): once a
  // user's recent withdrawals + this one exceed the cap, route to MANUAL review.
  if (cfg.dailyAutoCapCents && cfg.dailyAutoCapCents > 0 && (input.priorTodayCents ?? 0) + input.amountCents > cfg.dailyAutoCapCents) {
    reasons.push('above daily auto cap');
  }
  // money-7 GLOBAL 24h auto-payout budget (across ALL users): a hot-wallet-drain limiter
  // that doesn't depend on any single user's pattern — once the day's total auto-pay + this
  // one would breach, force MANUAL.
  if (cfg.globalAutoCapCents && cfg.globalAutoCapCents > 0 && (input.globalTodayCents ?? 0) + input.amountCents > cfg.globalAutoCapCents) {
    reasons.push('above global auto cap');
  }
  // money-7 PER-DESTINATION 24h cap: stops one address from auto-draining via many small
  // withdrawals (collusion cash-out funnel).
  if (cfg.destAutoCapCents && cfg.destAutoCapCents > 0 && (input.destTodayCents ?? 0) + input.amountCents > cfg.destAutoCapCents) {
    reasons.push('above per-destination auto cap');
  }
  // money-7: funds RECENTLY received via P2P transfer must not auto-cash-out (chip-dump /
  // laundering pass-through) — route to MANUAL so an operator eyeballs it.
  if ((input.recentTransferInCents ?? 0) > 0) {
    reasons.push('recent transfer-in (manual review)');
  }
  return { tier: reasons.length === 0 ? 'auto' : 'manual', reasons };
}
