// ============================================================================
// MURLAN — Auth service
// ----------------------------------------------------------------------------
// Registration, login, and refresh. Validates input, enforces unique
// username/email, hashes with Argon2id, and issues JWT access/refresh pairs.
// Throws AuthError (code + Albanian message) on any user-facing failure.
// ============================================================================

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { type UserRepository, type User, type UserRole, type ComplianceUpdate, type AccountStatePatch, DuplicateUserError } from './userRepository.ts';
import { AccountStateService, type AccountStatus, type AccountCheck } from './accountStateService.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { TokenService, type TokenPair } from './tokens.ts';
import { InMemoryRefreshTokens, type RefreshTokenRepository } from './refreshTokens.ts';
import {
  InMemoryVerificationTokens,
  hashToken,
  generateRawToken,
  type VerificationTokenRepository,
} from './verificationTokens.ts';
import { ConsoleEmailProvider, type EmailProvider } from '../email/emailProvider.ts';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // mirror the refresh JWT TTL
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h

const passwordSchema = z.string().min(8, 'Fjalëkalimi duhet të ketë të paktën 8 karaktere.');

export interface AuthServiceDeps {
  email?: EmailProvider;
  verificationTokens?: VerificationTokenRepository;
  appUrl?: string; // base URL used to build email links
  now?: () => number;
  // Per-identifier (email) failed-login throttle. Defaults to 5 failures / 10 min.
  loginThrottle?: { maxFailures: number; windowMs: number };
}

export class AuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const usernameSchema = z
  .string()
  .min(3, 'Përdoruesi duhet të ketë të paktën 3 shkronja.')
  .max(20, 'Përdoruesi nuk mund të kalojë 20 shkronja.')
  .regex(/^[a-zA-Z0-9_]+$/, 'Përdoruesi lejon vetëm shkronja, numra dhe nënvizë.');

// Email is matched case-INSENSITIVELY: phone keyboards auto-capitalize, so a user
// who registers as "Astek@x.com" must still log in typing "astek@x.com". Normalize
// (trim + lowercase) on EVERY entry point so the stored value and lookups agree.
const emailSchema = z
  .string()
  .email('Email i pavlefshëm.')
  .transform((e) => e.trim().toLowerCase());

const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: z.string().min(8, 'Fjalëkalimi duhet të ketë të paktën 8 karaktere.'),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Fjalëkalimi mungon.'),
});

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: string;
  permissions: string[]; // granular admin scopes; empty = full admin (back-compat)
  balanceCents: number;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, username: u.username, email: u.email, role: u.role, permissions: u.permissions ?? [], balanceCents: u.balanceCents };
}

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: TokenService,
    // Stateful refresh-token store (rotation/revocation). Defaults to in-memory so
    // single-instance dev/tests work; production injects the Prisma-backed store.
    private readonly refreshTokens: RefreshTokenRepository = new InMemoryRefreshTokens(),
    deps: AuthServiceDeps = {},
  ) {
    this.email = deps.email ?? new ConsoleEmailProvider();
    this.verificationTokens = deps.verificationTokens ?? new InMemoryVerificationTokens();
    this.appUrl = deps.appUrl ?? 'http://localhost:5173';
    this.now = deps.now ?? (() => Date.now());
    this.accountState = new AccountStateService(this.now);
    this.loginThrottle = deps.loginThrottle ?? { maxFailures: 5, windowMs: 10 * 60 * 1000 };
  }

  private readonly email: EmailProvider;
  private readonly verificationTokens: VerificationTokenRepository;
  private readonly appUrl: string;
  private readonly now: () => number;
  private readonly accountState: AccountStateService;
  private readonly loginThrottle: { maxFailures: number; windowMs: number };

  // Per-identifier (email) FAILED-login throttle (MONEY-7/WEB-2). Counts only failures
  // in a fixed window; a correct password clears it, so a legit user is never locked by
  // their own logins. Keyed by the submitted email — this defeats the proxy-IP rotation
  // that bypasses the per-IP HTTP rate-limit (one account can't be hammered no matter how
  // many IPs an attacker uses). Single-instance (in-memory), like the wallet/tournament
  // locks; multi-instance would back this with Redis (documented follow-up).
  private readonly loginFailures = new Map<string, { count: number; lastFailureAt: number; lockedUntil: number }>();
  // ESCALATING lockout (anti-brute-force): once the failure cap is hit, each FURTHER failure
  // extends the lockout, doubling the penalty (base window × 2^breaches) up to a ceiling.
  // A persistent attacker faces geometrically growing waits; a legit user (a few typos)
  // sees only the base window, and a correct password clears everything.
  private static readonly LOCKOUT_MAX_MS = 60 * 60 * 1000; // cap each lockout at 1 hour

  /** True if this identifier is currently locked out (within its escalating window). */
  private loginThrottled(idKey: string): boolean {
    const rec = this.loginFailures.get(idKey);
    if (!rec) return false;
    if (this.now() < rec.lockedUntil) return true; // still locked
    // Not locked. Forget the record only after a long idle period (the max lockout) since
    // the last failure — so a persistent attacker who returns AFTER a lock expires still
    // finds their count and escalates; a legit user who walks away decays to a clean slate.
    if (this.now() - rec.lastFailureAt >= AuthService.LOCKOUT_MAX_MS) { this.loginFailures.delete(idKey); return false; }
    return false;
  }

  /** Record one failed attempt for an identifier, extending the ESCALATING lockout. */
  private recordLoginFailure(idKey: string): void {
    const now = this.now();
    let rec = this.loginFailures.get(idKey);
    // Start fresh only when there is none, or the previous one has fully decayed (idle past
    // the max-lockout since its last failure) — otherwise keep counting so the lockout
    // escalates across consecutive failures, even ones spread across expired lock cycles.
    if (!rec || now - rec.lastFailureAt >= AuthService.LOCKOUT_MAX_MS) {
      rec = { count: 1, lastFailureAt: now, lockedUntil: 0 };
      this.loginFailures.set(idKey, rec);
    } else {
      rec.count += 1;
      rec.lastFailureAt = now;
    }
    // At/over the cap → (re)arm an escalating lockout: base window doubled per breach,
    // capped. breaches = how far past the cap we are.
    if (rec.count >= this.loginThrottle.maxFailures) {
      const breaches = rec.count - this.loginThrottle.maxFailures; // 0 on the first breach
      const penalty = Math.min(AuthService.LOCKOUT_MAX_MS, this.loginThrottle.windowMs * 2 ** breaches);
      rec.lockedUntil = now + penalty;
    }
    // Opportunistic prune so a spray across many distinct identifiers can't grow the map
    // without bound — drop every fully-decayed entry.
    if (this.loginFailures.size > 5000) {
      for (const [k, v] of this.loginFailures) {
        if (now - v.lastFailureAt >= AuthService.LOCKOUT_MAX_MS && now >= v.lockedUntil) this.loginFailures.delete(k);
      }
    }
  }

  // Per-ACCOUNT email-send throttle (anti mail-bomb — defeats the per-IP HTTP limit via
  // IP rotation). Caps how many reset/verification emails one identifier (email or userId)
  // triggers in a window. Single-instance (in-memory), like the login throttle; a returned
  // `false` means "skip the send" (the route still 200s — no enumeration). (throttles fix)
  private static readonly EMAIL_SEND_MAX = 3;            // per identifier
  private static readonly EMAIL_SEND_WINDOW_MS = 60 * 60 * 1000; // per 1 hour
  private readonly emailSends = new Map<string, { count: number; windowStart: number }>();
  /** True if another email may be sent for `idKey` now (and records the send). */
  private allowEmailSend(idKey: string): boolean {
    const now = this.now();
    const rec = this.emailSends.get(idKey);
    if (!rec || now - rec.windowStart >= AuthService.EMAIL_SEND_WINDOW_MS) {
      this.emailSends.set(idKey, { count: 1, windowStart: now });
      if (this.emailSends.size > 5000) {
        for (const [k, v] of this.emailSends) if (now - v.windowStart >= AuthService.EMAIL_SEND_WINDOW_MS) this.emailSends.delete(k);
      }
      return true;
    }
    if (rec.count >= AuthService.EMAIL_SEND_MAX) return false;
    rec.count += 1;
    return true;
  }

  // A real Argon2 hash to verify against when the email doesn't exist, so the user-miss
  // login branch costs the same as a real verify (defeats the enumeration timing oracle).
  // Computed lazily once and cached.
  private dummyHash: Promise<string> | null = null;
  private async dummyVerify(password: string): Promise<boolean> {
    if (!this.dummyHash) this.dummyHash = hashPassword('__murlan_dummy_password__');
    await verifyPassword(await this.dummyHash, password); // result ignored — always a "miss"
    return false;
  }

  /** The lifecycle status carried on a user, for the account-state gate. */
  private statusOf(user: User): AccountStatus {
    return { state: user.accountState, reason: user.accountStateReason, until: user.accountStateUntil };
  }

  /** Mint an access+refresh pair and PERSIST the refresh token (jti/family) so it
   *  can be rotated and revoked. Continues an existing rotation `family` if given. */
  private async issueSession(user: User, family?: string): Promise<TokenPair> {
    const jti = randomUUID();
    const fam = family ?? randomUUID();
    await this.refreshTokens.save({ jti, userId: user.id, family: fam, expiresAt: Date.now() + REFRESH_TTL_MS });
    return {
      // Stamp the access token with the user's current tokenVersion so a force-logout/
      // ban/reset (which bumps tokenVersion) invalidates it on the next request.
      accessToken: this.tokens.issueAccess(user.id, user.username, user.tokenVersion),
      refreshToken: this.tokens.issueRefresh(user.id, user.username, { jti, family: fam, ver: user.tokenVersion }),
    };
  }

  async register(input: unknown): Promise<AuthResult> {
    const parsed = registerSchema.safeParse(input);
    if (!parsed.success) {
      throw new AuthError('validation', parsed.error.issues[0]?.message ?? 'Të dhëna të pavlefshme.');
    }
    const { username, email, password } = parsed.data;

    // Timing-oracle equalization: ALWAYS spend the (expensive) password hash BEFORE the
    // uniqueness checks, so a "taken email/username" response costs the SAME wall-clock
    // time as a successful registration. (Previously the taken branches returned without
    // hashing — a timing oracle for enumerating registered emails/usernames.) The distinct
    // taken-email vs taken-username UX messages are preserved; only the timing leak is closed.
    const passwordHash = await hashPassword(password);

    if (await this.users.findByEmail(email)) {
      throw new AuthError('email_taken', 'Ky email është i regjistruar tashmë.');
    }
    if (await this.users.findByUsername(username)) {
      throw new AuthError('username_taken', 'Ky përdorues është i zënë.');
    }

    let user: User;
    try {
      user = await this.users.create({ username, email, passwordHash });
    } catch (e) {
      // A concurrent registration can pass the pre-checks above and still collide
      // at the unique constraint — translate that race to the same 409.
      if (e instanceof DuplicateUserError) {
        throw e.field === 'email'
          ? new AuthError('email_taken', 'Ky email është i regjistruar tashmë.')
          : new AuthError('username_taken', 'Ky përdorues është i zënë.');
      }
      throw e;
    }
    return { user: toPublicUser(user), tokens: await this.issueSession(user) };
  }

  async login(input: unknown): Promise<AuthResult> {
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) {
      throw new AuthError('validation', parsed.error.issues[0]?.message ?? 'Të dhëna të pavlefshme.');
    }
    const { email, password } = parsed.data;

    // Throttle BEFORE the lookup so behavior is identical whether or not the email
    // exists (no account enumeration) and a locked identifier costs no password hash.
    if (this.loginThrottled(email)) {
      throw new AuthError('rate_limited', 'Shumë përpjekje hyrjeje. Prit pak para se të provosh sërish.');
    }

    const user = await this.users.findByEmail(email);
    // Always run the password check shape AND spend a comparable amount of CPU whether or
    // not the email exists — verify against a real (dummy) Argon2 hash on the miss branch
    // so response time can't be used to enumerate registered emails (timing oracle).
    const okPassword = user
      ? await verifyPassword(user.passwordHash, password)
      : await this.dummyVerify(password);
    if (!user || !okPassword) {
      this.recordLoginFailure(email); // count this miss toward the per-identifier cap
      throw new AuthError('bad_credentials', 'Email ose fjalëkalim i gabuar.');
    }
    // Correct credentials → clear the failure window (a real user is never locked out
    // by their own successful login).
    this.loginFailures.delete(email);
    // Trust & safety: a banned / actively-suspended account cannot sign in.
    const gate = this.accountState.checkLogin(this.statusOf(user));
    if (!gate.allowed) throw new AuthError(gate.code!, gate.message!);
    return { user: toPublicUser(user), tokens: await this.issueSession(user) };
  }

  /**
   * Exchange a valid refresh token for a fresh pair, with ROTATION + reuse
   * detection. The presented jti must exist and be unrevoked; we revoke it and
   * issue a new token in the same family. A presented-but-revoked jti means the
   * token was replayed (theft) → revoke the whole family. A tokenVersion mismatch
   * means the session was force-invalidated (ban / logout-all).
   */
  async refresh(refreshToken: string): Promise<{ tokens: TokenPair; user: PublicUser }> {
    const expired = new AuthError('bad_refresh', 'Sesioni ka skaduar. Hyr përsëri.');
    let claims;
    try {
      claims = this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw expired;
    }
    const user = await this.users.findById(claims.sub);
    if (!user) throw expired;
    if (claims.ver !== user.tokenVersion) throw expired; // force-logout / ban
    if (!claims.jti) throw expired; // stateless legacy token no longer accepted
    // Block a session that was banned/suspended after the token was minted (a ban
    // also bumps tokenVersion above; this also catches a freshly-applied suspension).
    if (!this.accountState.checkLogin(this.statusOf(user)).allowed) throw expired;

    const record = await this.refreshTokens.find(claims.jti);
    if (!record) throw expired; // unknown jti
    if (record.expiresAt < Date.now()) throw expired;
    if (record.revoked) {
      // Already revoked when we read it ⇒ a replay of a rotated token ⇒ likely theft:
      // nuke the whole family.
      await this.refreshTokens.revokeFamily(record.family);
      throw expired;
    }

    // ATOMIC rotation (auth-3): revoke ONLY if still active. If two requests present the
    // same stolen token concurrently, exactly ONE wins the conditional revoke; the loser
    // gets false and we treat it as detected REUSE → revoke the family (no two live
    // sessions minted from one token, no find→revoke gap).
    const won = await this.refreshTokens.revokeIfActive(claims.jti);
    if (!won) {
      await this.refreshTokens.revokeFamily(record.family);
      throw expired;
    }
    return { tokens: await this.issueSession(user, record.family), user: toPublicUser(user) };
  }

  /** Revoke the refresh token behind a session (real logout, not just cookie clear). */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    try {
      const claims = this.tokens.verifyRefresh(refreshToken);
      if (claims.jti) await this.refreshTokens.revoke(claims.jti);
    } catch {
      /* already invalid — nothing to revoke */
    }
  }

  /** Force-invalidate ALL of a user's sessions (e.g. on ban, or self-service "log out
   *  all devices"). Bumps tokenVersion — so existing access tokens are rejected on the
   *  next request (revocation-aware authorizeRequest) and the next refresh fails the
   *  version check — AND revokes the stored refresh-token rows (defense-in-depth). */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.users.bumpTokenVersion(userId);
    await this.refreshTokens.revokeAllForUser(userId).catch(() => undefined);
  }

  // ---------- Email verification & password reset ---------------------------

  /** Email the user a single-use verification link (no-op if already verified). */
  async requestEmailVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.emailVerified) return;
    // Per-account mail-bomb cap (throttles fix) — silently skip once over the hourly limit.
    if (!this.allowEmailSend(`verify:${userId}`)) return;
    const raw = generateRawToken();
    await this.verificationTokens.create({ userId, type: 'email_verify', tokenHash: hashToken(raw), expiresAt: this.now() + EMAIL_VERIFY_TTL_MS });
    try {
      await this.email.send({
        to: user.email,
        subject: 'Verifiko email-in — Murlan',
        // The token rides in the URL FRAGMENT (#…), not the query (?…): a fragment is
        // never sent to the server, never written to nginx access logs, and never leaks
        // via the Referer header to the API (auth-4/11). The SPA reads it from
        // location.hash and strips it synchronously before any network call.
        text: `Përshëndetje ${user.username},\n\nKonfirmo email-in tënd:\n${this.appUrl}/#verifyEmail=${raw}\n\nLidhja skadon për 24 orë.`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[auth] verification email send failed:', err);
    }
  }

  /** Confirm a verification token; returns true on success. */
  async confirmEmailVerification(rawToken: string): Promise<boolean> {
    const rec = await this.verificationTokens.findValidByHash(hashToken(rawToken), 'email_verify', this.now());
    if (!rec) return false;
    await this.users.setEmailVerified(rec.userId, true);
    await this.verificationTokens.consume(rec.id, this.now());
    return true;
  }

  /** Email a password-reset link. ALWAYS succeeds silently (no account enumeration). */
  async requestPasswordReset(email: string): Promise<void> {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return;
    const user = await this.users.findByEmail(parsed.data);
    if (!user) return; // do not reveal whether the email exists
    // Per-account mail-bomb cap (throttles fix): cap reset emails per email-address per
    // hour, defeating the per-IP HTTP limit via IP rotation. Silently skip when over —
    // the route still returns 200 (no enumeration).
    if (!this.allowEmailSend(`reset:${parsed.data}`)) return;
    // Invalidate any older un-consumed reset tokens so only the newest link works (an
    // older link would otherwise stay valid for its 1h TTL).
    await this.verificationTokens.invalidateUnconsumed(user.id, 'password_reset', this.now()).catch(() => 0);
    const raw = generateRawToken();
    await this.verificationTokens.create({ userId: user.id, type: 'password_reset', tokenHash: hashToken(raw), expiresAt: this.now() + PASSWORD_RESET_TTL_MS });
    // FIRE-AND-FORGET the email: don't await the provider before returning, so the
    // response time doesn't depend on whether the email exists / how slow the mailer is
    // (no enumeration timing oracle). Errors are logged, never surfaced.
    void this.email.send({
      to: user.email,
      subject: 'Rivendos fjalëkalimin — Murlan',
      // FRAGMENT, not query — the single-use reset secret must not ride in the URL
      // query string (browser history / nginx logs / Referer to the API). See above.
      text: `Përshëndetje ${user.username},\n\nRivendos fjalëkalimin:\n${this.appUrl}/#resetPassword=${raw}\n\nLidhja skadon për 1 orë. Nëse nuk e kërkove ti, injoroje.`,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[auth] password-reset email send failed:', err);
    });
  }

  /** Reset the password with a valid token; revokes all existing sessions. */
  async resetPassword(rawToken: string, newPassword: string): Promise<boolean> {
    const parsed = passwordSchema.safeParse(newPassword);
    if (!parsed.success) throw new AuthError('validation', parsed.error.issues[0]?.message ?? 'Fjalëkalim i pavlefshëm.');
    const rec = await this.verificationTokens.findValidByHash(hashToken(rawToken), 'password_reset', this.now());
    if (!rec) return false;
    await this.users.setPassword(rec.userId, await hashPassword(newPassword));
    await this.verificationTokens.consume(rec.id, this.now());
    // Invalidate every OTHER un-consumed reset token for this user — a successful reset
    // should burn any other outstanding links, not just the one used.
    await this.verificationTokens.invalidateUnconsumed(rec.userId, 'password_reset', this.now()).catch(() => 0);
    await this.revokeAllSessions(rec.userId); // a reset logs out every existing session (tokenVersion + refresh rows)
    return true;
  }

  /** Fetch the public profile for a user id (e.g. GET /me). */
  async getUser(userId: string): Promise<PublicUser | null> {
    const user = await this.users.findById(userId);
    return user ? toPublicUser(user) : null;
  }

  /** Get (assigning on first call) the player's unique USDT-TRC20 deposit address.
   *  `derive` is the watch-only HD derivation for a given index. */
  assignDepositAddress(userId: string, derive: (index: number) => string): Promise<{ address: string; index: number } | null> {
    return this.users.assignDepositAddress(userId, derive);
  }

  /** Compliance view of a user (for ComplianceService gating). */
  async getComplianceProfile(userId: string): Promise<{
    kycStatus: 'none' | 'pending' | 'verified';
    dateOfBirth: string | null;
    country: string | null;
    selfExcludedUntil: number | null;
  } | null> {
    const user = await this.users.findById(userId);
    if (!user) return null;
    return {
      kycStatus: user.kycStatus,
      dateOfBirth: user.dateOfBirth,
      country: user.country,
      selfExcludedUntil: user.selfExcludedUntil,
    };
  }

  /** GDPR Art.15/20: the personal data we hold about a user, for self-service export.
   *  Returns null if the user no longer exists. (Financial activity — transactions and
   *  withdrawals — is assembled by the route from the money repos.) */
  async exportPersonalData(userId: string): Promise<{
    id: string;
    username: string;
    email: string;
    emailVerified: boolean;
    dateOfBirth: string | null;
    country: string | null;
    kycStatus: string;
    selfExcludedUntil: number | null;
    createdAt: number;
    xp: number;
  } | null> {
    const u = await this.users.findById(userId);
    if (!u) return null;
    return {
      id: u.id, username: u.username, email: u.email, emailVerified: u.emailVerified,
      dateOfBirth: u.dateOfBirth, country: u.country, kycStatus: u.kycStatus,
      selfExcludedUntil: u.selfExcludedUntil, createdAt: u.createdAt, xp: u.xp,
    };
  }

  /** GDPR Art.17: the user deletes their OWN account — irreversibly anonymize PII and
   *  close it (login blocked, sessions invalidated). Financial records (transactions/
   *  withdrawals) are retained per the legal/AML retention obligation. Returns false
   *  if the user no longer exists. */
  async deleteAccount(userId: string): Promise<boolean> {
    return this.users.anonymize(userId);
  }

  /** All users for the admin panel (includes KYC + account state). */
  async listUsers(): Promise<Array<PublicUser & { kycStatus: string; accountState: string }>> {
    return (await this.users.list()).map((u) => ({ ...toPublicUser(u), kycStatus: u.kycStatus, accountState: u.accountState }));
  }

  /** Every assigned per-player deposit address — for the treasury on-chain total. */
  async listDepositAddresses(): Promise<string[]> {
    return (await this.users.list()).map((u) => u.depositAddress).filter((a): a is string => !!a);
  }

  /** Set a user's platform role (admin promote/demote). Returns the updated user. */
  async setRole(userId: string, role: UserRole): Promise<PublicUser | null> {
    await this.users.setRole(userId, role);
    const u = await this.users.findById(userId);
    return u ? toPublicUser(u) : null;
  }

  /** Replace a user's granular admin permission scopes (RBAC). Returns the updated user. */
  async setPermissions(userId: string, permissions: string[]): Promise<PublicUser | null> {
    await this.users.setPermissions(userId, permissions);
    const u = await this.users.findById(userId);
    return u ? toPublicUser(u) : null;
  }

  /** The lifecycle status of a user (for gates / admin display). */
  async getAccountStatus(userId: string): Promise<AccountStatus | null> {
    const user = await this.users.findById(userId);
    return user ? this.statusOf(user) : null;
  }

  /**
   * Set a user's account lifecycle state (admin). When the new state blocks login
   * (banned / suspended) ALL existing sessions are revoked so the user is kicked
   * immediately (tokenVersion bump → next refresh fails; access tokens lapse within
   * their short TTL). Returns the updated public user + the resolved status.
   */
  async setAccountState(userId: string, patch: AccountStatePatch): Promise<{ user: PublicUser; status: AccountStatus } | null> {
    const user = await this.users.setAccountState(userId, patch);
    if (!user) return null;
    if (patch.state === 'banned' || patch.state === 'suspended') await this.revokeAllSessions(userId);
    return { user: toPublicUser(user), status: this.statusOf(user) };
  }

  /** Gate a real-money action (staked play / deposit) on the account state. */
  async checkAccountRealMoney(userId: string): Promise<AccountCheck> {
    const status = await this.getAccountStatus(userId);
    if (!status) return { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
    return this.accountState.checkRealMoney(status);
  }

  /** Gate a live connection / login on the account state (banned & suspended blocked).
   *  Used by the socket auth middleware so a banned user with a still-valid access
   *  token can't (re)connect — closing the live-token window after a ban. */
  async checkLogin(userId: string): Promise<AccountCheck> {
    const status = await this.getAccountStatus(userId);
    if (!status) return { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
    return this.accountState.checkLogin(status);
  }

  /** Update compliance fields (admin KYC verification, self-exclusion). Low-level
   *  — callers that expose this to end users MUST go through updateSelfProfile. */
  async updateCompliance(userId: string, patch: ComplianceUpdate): Promise<PublicUser | null> {
    const user = await this.users.updateCompliance(userId, patch);
    return user ? toPublicUser(user) : null;
  }

  /**
   * Self-service DOB/country update with the age/geo immutability gate enforced
   * HERE (service layer), not just at the route — so the control can't be bypassed
   * by a future caller. Once KYC is verified, DOB/country are locked (a correction
   * requires re-KYC). Returns whether a value actually changed (for auditing).
   */
  async updateSelfProfile(
    userId: string,
    patch: { dateOfBirth?: string; country?: string },
  ): Promise<{ ok: true; user: PublicUser | null; changed: boolean } | { ok: false; code: 'kyc_locked' }> {
    const current = await this.users.findById(userId);
    if (!current) return { ok: true, user: null, changed: false };
    const nextCountry = patch.country?.toUpperCase();
    const changingDob = patch.dateOfBirth !== undefined && patch.dateOfBirth !== current.dateOfBirth;
    const changingCountry = nextCountry !== undefined && nextCountry !== (current.country ?? null);
    if (current.kycStatus === 'verified' && (changingDob || changingCountry)) {
      return { ok: false, code: 'kyc_locked' };
    }
    const user = await this.users.updateCompliance(userId, { dateOfBirth: patch.dateOfBirth, country: nextCountry });
    return { ok: true, user: user ? toPublicUser(user) : null, changed: changingDob || changingCountry };
  }

  /** Verify an access token (Socket.IO handshake / REST guard). Throws on failure.
   *  Returns the token's `ver` (tokenVersion at issue) so callers can reject a stale
   *  token whose version no longer matches the live user (revocation-aware auth). */
  verifyAccess(token: string): { userId: string; username: string; ver: number } {
    try {
      const claims = this.tokens.verifyAccess(token);
      return { userId: claims.sub, username: claims.username, ver: claims.ver };
    } catch {
      throw new AuthError('unauthorized', 'Token i pavlefshëm.');
    }
  }

  /**
   * Revocation-aware authorization for a REST request. Verifies the access token,
   * then resolves the user ONCE and rejects when:
   *   • the user no longer exists,
   *   • the token's `ver` no longer matches the live tokenVersion (force-logout /
   *     ban / password-reset / "log out all devices"), or
   *   • the account state blocks login (banned / active suspension; frozen is allowed).
   * Returns the caller on success, or a structured failure the route maps to 401/403.
   * This closes the access-token window the socket gateway already guards (gateway.ts).
   */
  async authorizeRequest(token: string): Promise<
    | { ok: true; userId: string; username: string }
    | { ok: false; status: 401 | 403; code: string; message: string }
  > {
    let claims;
    try {
      claims = this.tokens.verifyAccess(token);
    } catch {
      return { ok: false, status: 401, code: 'unauthorized', message: 'Token i pavlefshëm.' };
    }
    const user = await this.users.findById(claims.sub);
    if (!user) return { ok: false, status: 401, code: 'unauthorized', message: 'Token i pavlefshëm.' };
    if (claims.ver !== user.tokenVersion) {
      // Stale token: a force-logout/ban/reset bumped tokenVersion after it was minted.
      return { ok: false, status: 401, code: 'unauthorized', message: 'Sesioni ka skaduar. Hyr përsëri.' };
    }
    const gate = this.accountState.checkLogin(this.statusOf(user));
    if (!gate.allowed) return { ok: false, status: 403, code: gate.code ?? 'blocked', message: gate.message ?? 'Llogaria është e bllokuar.' };
    return { ok: true, userId: user.id, username: user.username };
  }
}
