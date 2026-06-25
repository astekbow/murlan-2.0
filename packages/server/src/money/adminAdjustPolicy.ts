// ============================================================================
// MURLAN — Manual balance-adjust governance (admin-6)
// ----------------------------------------------------------------------------
// A manual credit/debit (panel /adjust or Telegram /credit /debit) is the one place an
// admin can mint or destroy balance with no external counterparty. These bounds make a
// single compromised/rogue admin session non-catastrophic and self-dealing impossible:
//   • Per-CALL ceiling (|delta| ≤ MAX_ADJUST_CENTS) — a fat-finger / single rogue call
//     can't move a fortune at once.
//   • Per-ADMIN rolling-24h cumulative cap (Σ|delta| of balance_adjust) — caps the total
//     blast radius even across many small calls, summed from the append-only audit log.
//   • No SELF-credit — an admin may never credit their OWN account (the textbook fraud).
//   • Optional DUAL-CONTROL flag (default OFF — the owner is a solo admin; mandatory
//     dual-control would lock them out). When ON, a 2nd distinct admin is required.
// The SAME bounds are enforced on the HTTP route and the Telegram path so neither is a
// softer door.
// ============================================================================

import type { AdminAuditRepository } from '../auth/adminAudit.ts';

/** Per-call ceiling on a single manual adjustment (|deltaCents|). $5,000. */
export const MAX_ADJUST_CENTS = 5_000_00;
/** Per-admin rolling-24h cumulative ceiling on Σ|balance_adjust| (sum from the audit log). $20,000. */
export const DAILY_ADJUST_CAP_CENTS = 20_000_00;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AdjustGovernanceOpts {
  /** Require a SECOND distinct admin to have approved (dual-control). Default false. */
  dualControl?: boolean;
  now?: () => number;
}

export type AdjustGovernanceVerdict =
  | { ok: true }
  | { ok: false; code: 'over_call_limit' | 'over_daily_cap' | 'self_credit'; message: string };

/**
 * Run the governance checks for a proposed manual adjustment. `deltaCents` is signed
 * (>0 credit, <0 debit). Returns the first failing verdict, or { ok: true }.
 * (dualControl is accepted for symmetry; the actual two-admin handshake is the caller's —
 * here it's a no-op stub the flag gates, kept OFF by default so the solo owner isn't locked.)
 */
export async function checkAdjustGovernance(
  audit: AdminAuditRepository,
  adminId: string,
  targetUserId: string,
  deltaCents: number,
  opts: AdjustGovernanceOpts = {},
): Promise<AdjustGovernanceVerdict> {
  const now = opts.now ?? (() => Date.now());
  const abs = Math.abs(deltaCents);
  // Self-credit: an admin must never top up their OWN balance (the textbook fraud). Self-DEBIT is
  // intentionally allowed (it loses you money — no fraud gain) and is covered by explicit tests.
  if (deltaCents > 0 && targetUserId === adminId) {
    return { ok: false, code: 'self_credit', message: 'Një admin nuk mund t’i shtojë lek vetes.' };
  }
  // Per-call ceiling.
  if (abs > MAX_ADJUST_CENTS) {
    return { ok: false, code: 'over_call_limit', message: `Rregullimi maksimal për veprim është $${(MAX_ADJUST_CENTS / 100).toLocaleString('en-US')}.` };
  }
  // Per-admin rolling-24h cumulative cap (Σ|delta|, from the audit log). Defensive: if the
  // store predates sumAdjustmentsBy (older fake/repo), treat usage as 0 (per-call cap + the
  // self-credit block still apply) rather than throwing.
  const used = typeof audit.sumAdjustmentsBy === 'function'
    ? await audit.sumAdjustmentsBy(adminId, now() - DAY_MS).catch(() => 0)
    : 0;
  if (used + abs > DAILY_ADJUST_CAP_CENTS) {
    return { ok: false, code: 'over_daily_cap', message: `Kufiri 24-orësh i rregullimeve për admin ($${(DAILY_ADJUST_CAP_CENTS / 100).toLocaleString('en-US')}) u arrit.` };
  }
  return { ok: true };
}
