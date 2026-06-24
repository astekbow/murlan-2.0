// ============================================================================
// MURLAN — User entity & repository
// ----------------------------------------------------------------------------
// The repository is an interface so the server can run on an in-memory store
// (tests, local dev) or PostgreSQL/Prisma (production) without changing callers.
// Balances live here as integer USD cents (money is settled in Phase 6).
// ============================================================================

import { levelInfo } from '../profile/level.ts';

export type UserRole = 'user' | 'admin';
export type KycStatus = 'none' | 'pending' | 'verified';
/**
 * Account lifecycle state (trust & safety enforcement, separate from compliance):
 *  active    — normal.
 *  frozen    — may log in + WITHDRAW, but staked play + deposits are blocked.
 *  suspended — temporary login block until `accountStateUntil` (then auto-active).
 *  banned    — permanent login block.
 */
export type AccountState = 'active' | 'frozen' | 'suspended' | 'banned';

export interface User {
  id: string;
  username: string;
  email: string;        // stored lowercased
  passwordHash: string;
  role: UserRole;
  // Granular admin scopes (RBAC). Empty = full admin (backward-compatible); a
  // non-empty list restricts that admin to those scopes. Irrelevant for non-admins.
  permissions: string[];
  balanceCents: number; // integer USD cents — never floats
  createdAt: number;    // epoch ms
  tokenVersion: number; // bumped to force-invalidate all refresh tokens
  emailVerified: boolean;
  // Account lifecycle (trust & safety). Defaults to 'active'; admin-set.
  accountState: AccountState;
  accountStateReason: string | null; // admin note explaining the state
  accountStateUntil: number | null;  // epoch ms — suspension expiry (null = permanent/none)
  // Per-player USDT-TRC20 deposit address (watch-only, derived from the deposit
  // xpub at `depositAddressIndex`). null until first assigned. Unique per account.
  depositAddress: string | null;
  depositAddressIndex: number | null;
  // Compliance (spec §13) — gated by ComplianceService switches.
  kycStatus: KycStatus;
  dateOfBirth: string | null;     // 'YYYY-MM-DD'
  country: string | null;         // ISO-2
  selfExcludedUntil: number | null; // epoch ms
  // Responsible-gaming self-imposed daily limits (cents; null = no limit).
  dailyDepositLimitCents: number | null;
  dailyLossLimitCents: number | null;
  // Progression & cosmetics (§2.3) — XP/stats only, never cashable.
  xp: number;
  // Lifetime XP SPENT in the XP shop (§2.6). `xp` is lifetime-earned and never decreases
  // (level stays levelInfo(xp)); the SPENDABLE XP balance = max(0, xp - xpSpent).
  xpSpent: number;
  gamesPlayed: number;
  wins: number;
  biggestPotCents: number;
  currentStreak: number;
  avatar: string | null;          // cosmetic avatar id
  // Engagement rewards (§2.6) — XP/cosmetic only.
  lastDailyClaim: number | null;  // epoch ms of last daily claim
  dailyStreak: number;
  cosmetics: string[];            // owned cosmetic ids
  cardBack: string | null;        // equipped
  tableFelt: string | null;       // equipped
  claimedChallenges: string[];
  // Rotating quests & level-up rewards (§2.6) — XP/cosmetic only, never cashable.
  // Claimed DAILY quests, keyed 'YYYY-MM-DD:questId' (resets next UTC day → quest is
  // fresh again with a new pool). Claimed WEEKLY quests, keyed 'YYYY-Www:questId'.
  // Level milestones already collected (idempotent one-time level-up rewards).
  claimedDailies: string[];
  claimedWeeklies: string[];
  collectedMilestones: number[];
}

/** Patch for reward/cosmetic fields. */
export interface RewardsPatch {
  lastDailyClaim?: number | null;
  dailyStreak?: number;
  cosmetics?: string[];
  cardBack?: string | null;
  tableFelt?: string | null;
  claimedChallenges?: string[];
  claimedDailies?: string[];
  claimedWeeklies?: string[];
  collectedMilestones?: number[];
}

/** A finished-match result applied to a player's cosmetic stats/XP. */
export interface MatchStatUpdate {
  won: boolean;
  potCents: number; // the pot this player was part of (for "biggest pot")
  xpGain: number;
}

export interface ComplianceUpdate {
  kycStatus?: KycStatus;
  dateOfBirth?: string | null;
  country?: string | null;
  selfExcludedUntil?: number | null;
}

/** Patch for responsible-gaming self-imposed limits (null clears a limit). */
export interface LimitsPatch {
  dailyDepositLimitCents?: number | null;
  dailyLossLimitCents?: number | null;
}

/** Patch for the account lifecycle state (admin action). */
export interface AccountStatePatch {
  state: AccountState;
  reason?: string | null;
  until?: number | null; // epoch ms (suspension expiry); null = permanent/none
}

export interface NewUser {
  username: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
}

/** Thrown by create() when a unique field collides, so callers map to a 409. */
export class DuplicateUserError extends Error {
  constructor(public readonly field: 'email' | 'username') {
    super(`${field} already exists`);
    this.name = 'DuplicateUserError';
  }
}

export interface UserRepository {
  create(u: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  /** Batch fetch by id (one query) — avoids N+1 round-trips on listings (e.g. the
   *  ranked leaderboard). Order is NOT guaranteed; callers index by id. */
  findManyByIds(ids: string[]): Promise<User[]>;
  findByEmail(email: string): Promise<User | null>;       // case-insensitive
  findByUsername(username: string): Promise<User | null>; // case-insensitive
  /**
   * Case-insensitive substring search on the username, for friend discovery. Bounded
   * (limit clamped ≤ 20), excludes `excludeUserId` (the caller). Returns a MINIMAL public
   * shape (id/username/avatar/level) — no email/stats. `level` is derived from xp.
   */
  searchByUsername(q: string, limit: number, excludeUserId?: string): Promise<Array<{ id: string; username: string; avatar: string | null; level: number }>>;
  /**
   * Atomically apply a signed delta to a balance and return the new balance.
   * Rejects (returns null) if the result would be negative — callers must
   * pre-check funds. Production impl runs this inside a DB transaction.
   */
  adjustBalance(id: string, deltaCents: number): Promise<number | null>;
  /**
   * Get the player's unique deposit address, assigning one ATOMICALLY on first
   * call: pick the next free index, derive its address via `derive(index)`, and
   * persist both. Idempotent — returns the existing pair if already assigned.
   * Returns null if the user doesn't exist. `derive` is a pure function (the
   * watch-only HD derivation); it's called inside the assignment so the index and
   * address stay consistent and unique.
   */
  assignDepositAddress(id: string, derive: (index: number) => string): Promise<{ address: string; index: number } | null>;
  /** Patch compliance fields (KYC status, DOB, country, self-exclusion). */
  updateCompliance(id: string, patch: ComplianceUpdate): Promise<User | null>;
  /** Set/clear responsible-gaming daily limits. */
  setLimits(id: string, patch: LimitsPatch): Promise<User | null>;
  /** Set the account lifecycle state (admin: suspend/freeze/ban/reactivate). */
  setAccountState(id: string, patch: AccountStatePatch): Promise<User | null>;
  /** All users (admin listing). Production impl should paginate. */
  list(): Promise<User[]>;
  /** Apply a finished match to a player's cosmetic stats/XP. */
  applyMatchResult(id: string, r: MatchStatUpdate): Promise<User | null>;
  /** Set the cosmetic avatar id. */
  setAvatar(id: string, avatar: string): Promise<User | null>;
  /** Top users by XP (leaderboard). */
  topByXp(limit: number): Promise<User[]>;
  /** Add (or subtract, clamped ≥0) cosmetic XP. */
  addXp(id: string, deltaXp: number): Promise<User | null>;
  /** Patch reward/cosmetic fields. */
  setRewards(id: string, patch: RewardsPatch): Promise<User | null>;
  /** Increment tokenVersion (force-logout: invalidates all refresh tokens). */
  bumpTokenVersion(id: string): Promise<number | null>;
  /** GDPR Art.17: irreversibly anonymize a user's PII (username/email/DOB/country/
   *  avatar scrubbed, password made unusable), close the account (can't log in) and
   *  invalidate sessions. Financial rows (transactions/withdrawals) are intentionally
   *  RETAINED (legal/AML obligation) with the now-anonymized user id. */
  anonymize(id: string): Promise<boolean>;
  /**
   * Atomically buy a cosmetic: succeed ONLY if xp >= cost AND it isn't already
   * owned, deducting xp and appending the id in one operation. Prevents the
   * read-check-write race that could double-spend XP or duplicate the grant.
   */
  purchaseCosmetic(id: string, cosmeticId: string, cost: number): Promise<{ ok: boolean; code?: string }>;
  /**
   * Atomically buy a cosmetic with SPENDABLE XP (xp - xpSpent): succeed ONLY if it isn't
   * already owned AND (xp - xpSpent) >= costXp, incrementing `xpSpent` (never `xp`, so the
   * level is unaffected) and appending the id in one operation. The XP economy parallels
   * the money one — it NEVER touches the wallet.
   */
  purchaseCosmeticXp(id: string, cosmeticId: string, costXp: number): Promise<{ ok: boolean; code?: string }>;
  /** Mark a user's email verified/unverified. */
  setEmailVerified(id: string, verified: boolean): Promise<void>;
  /** Replace the password hash (password reset). */
  setPassword(id: string, passwordHash: string): Promise<void>;
  /** Set a user's platform role (admin bootstrap). */
  setRole(id: string, role: UserRole): Promise<void>;
  /** Replace a user's granular admin permission scopes (RBAC). */
  setPermissions(id: string, permissions: string[]): Promise<void>;
}

/** In-memory repository for tests and single-instance local dev. */
export class InMemoryUserRepository implements UserRepository {
  private byId = new Map<string, User>();
  private byEmail = new Map<string, string>();    // lowercased email -> id
  private byUsername = new Map<string, string>(); // lowercased username -> id
  private seq = 0;

  async create(u: NewUser): Promise<User> {
    const email = u.email.toLowerCase();
    const unameKey = u.username.toLowerCase();
    if (this.byEmail.has(email)) throw new DuplicateUserError('email');
    if (this.byUsername.has(unameKey)) throw new DuplicateUserError('username');

    this.seq += 1;
    const user: User = {
      id: `u_${this.seq}`,
      username: u.username,
      email,
      passwordHash: u.passwordHash,
      role: u.role ?? 'user',
      permissions: [],
      balanceCents: 0,
      createdAt: epochMs(),
      tokenVersion: 0,
      emailVerified: false,
      accountState: 'active',
      accountStateReason: null,
      accountStateUntil: null,
      depositAddress: null,
      depositAddressIndex: null,
      kycStatus: 'none',
      dateOfBirth: null,
      country: null,
      selfExcludedUntil: null,
      dailyDepositLimitCents: null,
      dailyLossLimitCents: null,
      xp: 0,
      xpSpent: 0,
      gamesPlayed: 0,
      wins: 0,
      biggestPotCents: 0,
      currentStreak: 0,
      avatar: null,
      lastDailyClaim: null,
      dailyStreak: 0,
      cosmetics: [],
      cardBack: null,
      tableFelt: null,
      claimedChallenges: [],
      claimedDailies: [],
      claimedWeeklies: [],
      collectedMilestones: [],
    };
    this.byId.set(user.id, user);
    this.byEmail.set(email, user.id);
    this.byUsername.set(unameKey, user.id);
    return { ...user };
  }

  async findById(id: string): Promise<User | null> {
    const u = this.byId.get(id);
    return u ? { ...u } : null;
  }

  async findManyByIds(ids: string[]): Promise<User[]> {
    const out: User[] = [];
    for (const id of ids) {
      const u = this.byId.get(id);
      if (u) out.push({ ...u });
    }
    return out;
  }

  async assignDepositAddress(id: string, derive: (index: number) => string): Promise<{ address: string; index: number } | null> {
    const u = this.byId.get(id);
    if (!u) return null;
    if (u.depositAddress != null && u.depositAddressIndex != null) return { address: u.depositAddress, index: u.depositAddressIndex };
    const used = [...this.byId.values()].map((x) => x.depositAddressIndex).filter((i): i is number => i != null);
    const index = used.length ? Math.max(...used) + 1 : 0;
    const address = derive(index);
    u.depositAddress = address;
    u.depositAddressIndex = index;
    return { address, index };
  }

  async findByEmail(email: string): Promise<User | null> {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? this.findById(id) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const id = this.byUsername.get(username.toLowerCase());
    return id ? this.findById(id) : null;
  }

  async searchByUsername(q: string, limit: number, excludeUserId?: string): Promise<Array<{ id: string; username: string; avatar: string | null; level: number }>> {
    const needle = q.trim().toLowerCase();
    if (needle.length === 0) return [];
    const cap = Math.max(0, Math.min(20, Math.floor(limit)));
    const out: Array<{ id: string; username: string; avatar: string | null; level: number }> = [];
    for (const u of this.byId.values()) {
      if (u.id === excludeUserId) continue;
      if (!u.username.toLowerCase().includes(needle)) continue;
      out.push({ id: u.id, username: u.username, avatar: u.avatar, level: levelInfo(u.xp).level });
      if (out.length >= cap) break;
    }
    return out;
  }

  async adjustBalance(id: string, deltaCents: number): Promise<number | null> {
    const user = this.byId.get(id); // mutate the stored record, not a copy
    if (!user) return null;
    const next = user.balanceCents + deltaCents;
    if (next < 0) return null; // insufficient funds — caller must handle
    user.balanceCents = next;
    return next;
  }

  async updateCompliance(id: string, patch: ComplianceUpdate): Promise<User | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    if (patch.kycStatus !== undefined) user.kycStatus = patch.kycStatus;
    if (patch.dateOfBirth !== undefined) user.dateOfBirth = patch.dateOfBirth;
    if (patch.country !== undefined) user.country = patch.country;
    if (patch.selfExcludedUntil !== undefined) user.selfExcludedUntil = patch.selfExcludedUntil;
    return { ...user };
  }

  async setLimits(id: string, patch: LimitsPatch): Promise<User | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    if (patch.dailyDepositLimitCents !== undefined) user.dailyDepositLimitCents = patch.dailyDepositLimitCents;
    if (patch.dailyLossLimitCents !== undefined) user.dailyLossLimitCents = patch.dailyLossLimitCents;
    return { ...user };
  }

  async setAccountState(id: string, patch: AccountStatePatch): Promise<User | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    user.accountState = patch.state;
    user.accountStateReason = patch.reason ?? null;
    user.accountStateUntil = patch.until ?? null;
    return { ...user };
  }

  async anonymize(id: string): Promise<boolean> {
    const user = this.byId.get(id);
    if (!user) return false;
    const suffix = id.slice(0, 8).toLowerCase();
    user.username = `deleted_${suffix}`; // findByUsername lowercases, so the old name no longer matches
    user.email = `deleted_${id}@deleted.invalid`;
    user.passwordHash = '!anonymized!'; // unusable hash → password login can never match
    user.dateOfBirth = null;
    user.country = null;
    user.avatar = null;
    user.accountState = 'banned'; // closed: blocks login (reason marks it as self-deletion)
    user.accountStateReason = 'account_self_deleted';
    user.accountStateUntil = null;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1; // invalidate existing sessions
    return true;
  }

  async list(): Promise<User[]> {
    return [...this.byId.values()].map((u) => ({ ...u }));
  }

  async applyMatchResult(id: string, r: MatchStatUpdate): Promise<User | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    user.gamesPlayed += 1;
    user.wins += r.won ? 1 : 0;
    user.xp += Math.max(0, Math.floor(r.xpGain));
    user.currentStreak = r.won ? user.currentStreak + 1 : 0;
    user.biggestPotCents = Math.max(user.biggestPotCents, r.potCents);
    return { ...user };
  }

  async setAvatar(id: string, avatar: string): Promise<User | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    user.avatar = avatar;
    return { ...user };
  }

  async topByXp(limit: number): Promise<User[]> {
    return [...this.byId.values()]
      .sort((a, b) => b.xp - a.xp || b.wins - a.wins)
      .slice(0, Math.max(0, limit))
      .map((u) => ({ ...u }));
  }

  async addXp(id: string, deltaXp: number): Promise<User | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    user.xp = Math.max(0, user.xp + Math.floor(deltaXp));
    return { ...user };
  }

  async setRewards(id: string, patch: RewardsPatch): Promise<User | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    if (patch.lastDailyClaim !== undefined) user.lastDailyClaim = patch.lastDailyClaim;
    if (patch.dailyStreak !== undefined) user.dailyStreak = patch.dailyStreak;
    if (patch.cosmetics !== undefined) user.cosmetics = [...patch.cosmetics];
    if (patch.cardBack !== undefined) user.cardBack = patch.cardBack;
    if (patch.tableFelt !== undefined) user.tableFelt = patch.tableFelt;
    if (patch.claimedChallenges !== undefined) user.claimedChallenges = [...patch.claimedChallenges];
    if (patch.claimedDailies !== undefined) user.claimedDailies = [...patch.claimedDailies];
    if (patch.claimedWeeklies !== undefined) user.claimedWeeklies = [...patch.claimedWeeklies];
    if (patch.collectedMilestones !== undefined) user.collectedMilestones = [...patch.collectedMilestones];
    return { ...user };
  }

  async bumpTokenVersion(id: string): Promise<number | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    user.tokenVersion += 1;
    return user.tokenVersion;
  }

  async purchaseCosmetic(id: string, cosmeticId: string, cost: number): Promise<{ ok: boolean; code?: string }> {
    const user = this.byId.get(id); // synchronous read-modify-write is atomic in-memory
    if (!user) return { ok: false, code: 'not_found' };
    if (user.cosmetics.includes(cosmeticId)) return { ok: false, code: 'owned' };
    if (user.xp < cost) return { ok: false, code: 'insufficient_xp' };
    user.xp -= cost;
    user.cosmetics = [...user.cosmetics, cosmeticId];
    return { ok: true };
  }

  async purchaseCosmeticXp(id: string, cosmeticId: string, costXp: number): Promise<{ ok: boolean; code?: string }> {
    const user = this.byId.get(id); // synchronous read-modify-write is atomic in-memory
    if (!user) return { ok: false, code: 'not_found' };
    if (user.cosmetics.includes(cosmeticId)) return { ok: true }; // idempotent: already owned
    const spendable = Math.max(0, user.xp - user.xpSpent);
    if (spendable < costXp) return { ok: false, code: 'insufficient_xp' };
    user.xpSpent += costXp; // SPEND from the parallel balance — `xp` (and level) untouched
    user.cosmetics = [...user.cosmetics, cosmeticId];
    return { ok: true };
  }

  async setEmailVerified(id: string, verified: boolean): Promise<void> {
    const user = this.byId.get(id);
    if (user) user.emailVerified = verified;
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    const user = this.byId.get(id);
    if (user) user.passwordHash = passwordHash;
  }

  async setRole(id: string, role: UserRole): Promise<void> {
    const user = this.byId.get(id);
    if (user) user.role = role;
  }

  async setPermissions(id: string, permissions: string[]): Promise<void> {
    const user = this.byId.get(id);
    if (user) user.permissions = [...permissions];
  }
}

// Date.now() is wrapped so the rest of the module imports a single clock.
function epochMs(): number {
  return Date.now();
}
