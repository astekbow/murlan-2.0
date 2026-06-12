// Semi-automatic withdrawal triage (pure, no I/O). Classifies a withdrawal into
// a handling TIER so the operator can fast-track the safe ones:
//   • 'auto'   — small AND the player's KYC is verified → safe to approve quickly
//   • 'manual' — large, unverified, or the feature is off → review before paying
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
  input: { amountCents: number; kycStatus: string | null | undefined },
  cfg: { autoMaxCents: number },
): WithdrawalClassification {
  const reasons: string[] = [];
  if (cfg.autoMaxCents <= 0) {
    reasons.push('auto disabled');
  } else if (input.amountCents > cfg.autoMaxCents) {
    reasons.push('above auto threshold');
  }
  if (input.kycStatus !== 'verified') reasons.push('KYC not verified');
  return { tier: reasons.length === 0 ? 'auto' : 'manual', reasons };
}
