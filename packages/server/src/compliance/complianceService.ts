// ============================================================================
// MURLAN — Compliance gating (Phase 7, spec §13)
// ----------------------------------------------------------------------------
// Real-money gambling requires KYC, age verification, geo-restrictions and
// responsible-gaming controls. These are built as SWITCHES that are OFF by
// default (so dev/free play is unaffected) and can be turned on per deployment.
// When all flags are off, every check passes — but the hooks are already wired
// at the real-money entry points (staked match start, deposits).
// ============================================================================

export interface ComplianceConfig {
  kycRequired: boolean;        // require kycStatus === 'verified'
  minAge: number;              // 0 disables age gating
  blockedCountries: string[];  // ISO-2 codes (uppercased)
  responsibleGaming: boolean;  // honor self-exclusion
}

export type KycStatus = 'none' | 'pending' | 'verified';

export interface ComplianceProfile {
  kycStatus: KycStatus;
  dateOfBirth: string | null;     // 'YYYY-MM-DD'
  country: string | null;         // ISO-2
  selfExcludedUntil: number | null; // epoch ms
}

export interface ComplianceResult {
  allowed: boolean;
  code?: string;
  message?: string; // Albanian, player-facing
}

const ALLOWED: ComplianceResult = { allowed: true };
const block = (code: string, message: string): ComplianceResult => ({ allowed: false, code, message });

/** Full years between a 'YYYY-MM-DD' birth date and `nowMs`, or null if unparseable. */
export function ageInYears(dateOfBirth: string | null, nowMs: number): number | null {
  if (!dateOfBirth) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - y;
  const beforeBirthday =
    now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

export class ComplianceService {
  constructor(
    private readonly cfg: ComplianceConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True if any control is switched on (lets callers skip work when fully off). */
  get enabled(): boolean {
    return this.cfg.kycRequired || this.cfg.minAge > 0 || this.cfg.blockedCountries.length > 0 || this.cfg.responsibleGaming;
  }

  /** Gate a real-money action (staked match, deposit). Passes when flags are off. */
  checkRealMoney(profile: ComplianceProfile): ComplianceResult {
    if (this.cfg.responsibleGaming && profile.selfExcludedUntil && this.now() < profile.selfExcludedUntil) {
      return block('self_excluded', 'Llogaria është në vetëpërjashtim.');
    }
    if (this.cfg.kycRequired && profile.kycStatus !== 'verified') {
      return block('kyc_required', 'Kërkohet verifikimi i identitetit (KYC).');
    }
    if (this.cfg.minAge > 0) {
      const age = ageInYears(profile.dateOfBirth, this.now());
      if (age === null || age < this.cfg.minAge) {
        return block('age_restricted', `Duhet të jesh të paktën ${this.cfg.minAge} vjeç.`);
      }
    }
    if (this.cfg.blockedCountries.length > 0 && profile.country && this.cfg.blockedCountries.includes(profile.country.trim().toUpperCase())) {
      return block('geo_blocked', 'Loja për para nuk lejohet në vendin tënd.');
    }
    return ALLOWED;
  }

  /**
   * Gate a WITHDRAWAL. Self-exclusion must STOP a user playing/depositing but it
   * must NOT trap their own funds — letting them cash out is a consumer-protection
   * requirement. So this enforces KYC/age/geo (per policy) but, unlike
   * checkRealMoney, does NOT block on self-exclusion.
   */
  checkWithdrawal(profile: ComplianceProfile): ComplianceResult {
    if (this.cfg.kycRequired && profile.kycStatus !== 'verified') {
      return block('kyc_required', 'Kërkohet verifikimi i identitetit (KYC) për tërheqje.');
    }
    if (this.cfg.minAge > 0) {
      const age = ageInYears(profile.dateOfBirth, this.now());
      if (age === null || age < this.cfg.minAge) {
        return block('age_restricted', `Duhet të jesh të paktën ${this.cfg.minAge} vjeç.`);
      }
    }
    if (this.cfg.blockedCountries.length > 0 && profile.country && this.cfg.blockedCountries.includes(profile.country.trim().toUpperCase())) {
      return block('geo_blocked', 'Tërheqja nuk lejohet në vendin tënd.');
    }
    return ALLOWED;
  }
}
