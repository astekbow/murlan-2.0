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
  input: { amountCents: number; kycStatus?: string | null | undefined; priorTodayCents?: number },
  cfg: { autoMaxCents: number; dailyAutoCapCents?: number },
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
  return { tier: reasons.length === 0 ? 'auto' : 'manual', reasons };
}
