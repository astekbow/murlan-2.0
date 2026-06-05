// ============================================================================
// MURLAN — Account-state gating (trust & safety)
// ----------------------------------------------------------------------------
// Enforcement for the account lifecycle (active/frozen/suspended/banned),
// separate from ComplianceService (KYC/age/geo). Unlike compliance there is NO
// off switch: a banned or suspended account must always be blocked, regardless
// of deployment flags. Pure given an injected clock, so it is unit-testable and
// identical in-memory and on Postgres.
//
//   banned    → cannot log in (permanent).
//   suspended → cannot log in until `until` (then auto-active).
//   frozen    → may log in + withdraw, but staked play + deposits are blocked.
//   active    → unrestricted.
// ============================================================================

import type { AccountState } from './userRepository.ts';

export interface AccountStatus {
  state: AccountState;
  reason: string | null;
  until: number | null; // epoch ms — suspension expiry
}

export interface AccountCheck {
  allowed: boolean;
  code?: string;
  message?: string; // Albanian, player-facing
}

const ALLOWED: AccountCheck = { allowed: true };

export class AccountStateService {
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Effective state, resolving an expired suspension back to 'active'. */
  effective(s: AccountStatus): AccountState {
    if (s.state === 'suspended' && s.until !== null && this.now() >= s.until) return 'active';
    return s.state;
  }

  /** May this account sign in / refresh a session? Banned + active suspension block. */
  checkLogin(s: AccountStatus): AccountCheck {
    const eff = this.effective(s);
    if (eff === 'banned') return { allowed: false, code: 'account_banned', message: 'Llogaria është pezulluar përgjithmonë.' };
    if (eff === 'suspended') return { allowed: false, code: 'account_suspended', message: 'Llogaria është pezulluar përkohësisht.' };
    return ALLOWED;
  }

  /** May this account stake a match / deposit? Frozen (and the login-blocked states) block. */
  checkRealMoney(s: AccountStatus): AccountCheck {
    const eff = this.effective(s);
    if (eff === 'banned') return { allowed: false, code: 'account_banned', message: 'Llogaria është pezulluar.' };
    if (eff === 'suspended') return { allowed: false, code: 'account_suspended', message: 'Llogaria është pezulluar përkohësisht.' };
    if (eff === 'frozen') return { allowed: false, code: 'account_frozen', message: 'Llogaria është ngrirë — loja me bast dhe depozitat janë çaktivizuar.' };
    return ALLOWED;
  }
}
