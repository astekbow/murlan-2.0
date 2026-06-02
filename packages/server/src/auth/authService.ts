// ============================================================================
// MURLAN — Auth service
// ----------------------------------------------------------------------------
// Registration, login, and refresh. Validates input, enforces unique
// username/email, hashes with Argon2id, and issues JWT access/refresh pairs.
// Throws AuthError (code + Albanian message) on any user-facing failure.
// ============================================================================

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { type UserRepository, type User, type ComplianceUpdate, DuplicateUserError } from './userRepository.ts';
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

const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().email('Email i pavlefshëm.'),
  password: z.string().min(8, 'Fjalëkalimi duhet të ketë të paktën 8 karaktere.'),
});

const loginSchema = z.object({
  email: z.string().email('Email i pavlefshëm.'),
  password: z.string().min(1, 'Fjalëkalimi mungon.'),
});

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: string;
  balanceCents: number;
}

export interface AuthResult {
  user: PublicUser;
  tokens: TokenPair;
}

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, username: u.username, email: u.email, role: u.role, balanceCents: u.balanceCents };
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
  }

  private readonly email: EmailProvider;
  private readonly verificationTokens: VerificationTokenRepository;
  private readonly appUrl: string;
  private readonly now: () => number;

  /** Mint an access+refresh pair and PERSIST the refresh token (jti/family) so it
   *  can be rotated and revoked. Continues an existing rotation `family` if given. */
  private async issueSession(user: User, family?: string): Promise<TokenPair> {
    const jti = randomUUID();
    const fam = family ?? randomUUID();
    await this.refreshTokens.save({ jti, userId: user.id, family: fam, expiresAt: Date.now() + REFRESH_TTL_MS });
    return {
      accessToken: this.tokens.issueAccess(user.id, user.username),
      refreshToken: this.tokens.issueRefresh(user.id, user.username, { jti, family: fam, ver: user.tokenVersion }),
    };
  }

  async register(input: unknown): Promise<AuthResult> {
    const parsed = registerSchema.safeParse(input);
    if (!parsed.success) {
      throw new AuthError('validation', parsed.error.issues[0]?.message ?? 'Të dhëna të pavlefshme.');
    }
    const { username, email, password } = parsed.data;

    if (await this.users.findByEmail(email)) {
      throw new AuthError('email_taken', 'Ky email është i regjistruar tashmë.');
    }
    if (await this.users.findByUsername(username)) {
      throw new AuthError('username_taken', 'Ky përdorues është i zënë.');
    }

    const passwordHash = await hashPassword(password);
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

    const user = await this.users.findByEmail(email);
    // Always run the password check shape; use a generic message to avoid
    // revealing whether the email exists.
    const okPassword = user ? await verifyPassword(user.passwordHash, password) : false;
    if (!user || !okPassword) {
      throw new AuthError('bad_credentials', 'Email ose fjalëkalim i gabuar.');
    }
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

    const record = await this.refreshTokens.find(claims.jti);
    if (!record) throw expired; // unknown jti
    if (record.revoked) {
      // Replay of an already-rotated token ⇒ likely theft: nuke the whole family.
      await this.refreshTokens.revokeFamily(record.family);
      throw expired;
    }
    if (record.expiresAt < Date.now()) throw expired;

    await this.refreshTokens.revoke(claims.jti); // rotate
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

  /** Force-invalidate ALL of a user's sessions (e.g. on ban). The next refresh
   *  fails the tokenVersion check; existing access tokens lapse within their TTL. */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.users.bumpTokenVersion(userId);
  }

  // ---------- Email verification & password reset ---------------------------

  /** Email the user a single-use verification link (no-op if already verified). */
  async requestEmailVerification(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.emailVerified) return;
    const raw = generateRawToken();
    await this.verificationTokens.create({ userId, type: 'email_verify', tokenHash: hashToken(raw), expiresAt: this.now() + EMAIL_VERIFY_TTL_MS });
    await this.email.send({
      to: user.email,
      subject: 'Verifiko email-in — Murlan',
      text: `Përshëndetje ${user.username},\n\nKonfirmo email-in tënd:\n${this.appUrl}/?verifyEmail=${raw}\n\nLidhja skadon për 24 orë.`,
    });
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
    const parsed = z.string().email().safeParse(email);
    if (!parsed.success) return;
    const user = await this.users.findByEmail(parsed.data);
    if (!user) return; // do not reveal whether the email exists
    const raw = generateRawToken();
    await this.verificationTokens.create({ userId: user.id, type: 'password_reset', tokenHash: hashToken(raw), expiresAt: this.now() + PASSWORD_RESET_TTL_MS });
    await this.email.send({
      to: user.email,
      subject: 'Rivendos fjalëkalimin — Murlan',
      text: `Përshëndetje ${user.username},\n\nRivendos fjalëkalimin:\n${this.appUrl}/?resetPassword=${raw}\n\nLidhja skadon për 1 orë. Nëse nuk e kërkove ti, injoroje.`,
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
    await this.users.bumpTokenVersion(rec.userId); // a reset logs out every existing session
    return true;
  }

  /** Fetch the public profile for a user id (e.g. GET /me). */
  async getUser(userId: string): Promise<PublicUser | null> {
    const user = await this.users.findById(userId);
    return user ? toPublicUser(user) : null;
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

  /** All users for the admin panel (includes KYC status). */
  async listUsers(): Promise<Array<PublicUser & { kycStatus: string }>> {
    return (await this.users.list()).map((u) => ({ ...toPublicUser(u), kycStatus: u.kycStatus }));
  }

  /** Update compliance fields (admin KYC verification, self-service DOB/country, self-exclusion). */
  async updateCompliance(userId: string, patch: ComplianceUpdate): Promise<PublicUser | null> {
    const user = await this.users.updateCompliance(userId, patch);
    return user ? toPublicUser(user) : null;
  }

  /** Verify an access token (Socket.IO handshake / REST guard). Throws on failure. */
  verifyAccess(token: string): { userId: string; username: string } {
    try {
      const claims = this.tokens.verifyAccess(token);
      return { userId: claims.sub, username: claims.username };
    } catch {
      throw new AuthError('unauthorized', 'Token i pavlefshëm.');
    }
  }
}
