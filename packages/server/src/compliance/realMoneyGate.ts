// ============================================================================
// MURLAN — Shared real-money entry gate
// ----------------------------------------------------------------------------
// The staked-match path (gateway.tryBeginMatch) gates every real-money entry on
// account-state → compliance (KYC/age/geo/self-exclusion) → responsible-gaming
// loss cap. Tournaments and the cosmetic shop are ALSO real-money entry points,
// so they must enforce the same controls (audit 2026-06-08, finding H2). This is
// the one place that policy lives, reused by both new routes.
// ============================================================================

import type { AuthService } from '../auth/authService.ts';
import type { ComplianceService } from './complianceService.ts';
import type { ResponsibleGamingService } from './responsibleGaming.ts';

export interface RealMoneyGateDeps {
  auth: AuthService;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService;
}

export interface GateVerdict {
  allowed: boolean;
  code?: string;
  message?: string; // Albanian, player-facing
}

/**
 * Run the full real-money entry gate for `userId`:
 *  1. Account state (always on) — banned/frozen accounts can't transact.
 *  2. Compliance (when enabled) — KYC, age, geo, self-exclusion.
 *  3. Responsible-gaming daily loss cap (only when `opts.checkLoss`, i.e. a wager
 *     like a tournament buy-in — NOT a cosmetic purchase).
 * Returns the first failing verdict, or { allowed: true }.
 */
export async function checkRealMoneyAccess(
  deps: RealMoneyGateDeps,
  userId: string,
  opts: { checkLoss?: boolean } = {},
): Promise<GateVerdict> {
  const acct = await deps.auth.checkAccountRealMoney(userId);
  if (!acct.allowed) return { allowed: false, code: acct.code ?? 'account', message: acct.message ?? 'Bllokuar.' };

  if (deps.compliance?.enabled) {
    const profile = await deps.auth.getComplianceProfile(userId);
    const verdict = profile
      ? deps.compliance.checkRealMoney(profile)
      : { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
    if (!verdict.allowed) return { allowed: false, code: verdict.code ?? 'compliance', message: verdict.message ?? 'Bllokuar.' };
  }

  if (opts.checkLoss && deps.rg) {
    const loss = await deps.rg.checkLoss(userId);
    if (!loss.allowed) return { allowed: false, code: loss.code ?? 'loss_limit', message: loss.message ?? 'Bllokuar.' };
  }

  return { allowed: true };
}
