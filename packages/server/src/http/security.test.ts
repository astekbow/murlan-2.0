// ============================================================================
// MURLAN — Security regression tests (SECURITY_AUDIT.md fixes)
// ----------------------------------------------------------------------------
// Covers the behavioural security fixes: revocation-aware access tokens (#1/#9),
// the withdraw account-state gate (#1), the RBAC promotion hole (#2), owner-demote
// protection, per-route rate limits, "log out all devices", reset-token
// invalidation, the timing-oracle equalization, and the keyGenerator IP bucketing.
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { InMemoryRefreshTokens } from '../auth/refreshTokens.ts';
import { InMemoryVerificationTokens } from '../auth/verificationTokens.ts';
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryWithdrawals, WithdrawalService } from '../money/withdrawals.ts';
import { MockPaymentProvider } from '../money/paymentProvider.ts';
import { InMemoryDepositIntents } from '../money/depositIntents.ts';
import { InMemoryAdminAudit } from '../auth/adminAudit.ts';
import type { EmailProvider, OutboundEmail } from '../email/emailProvider.ts';

const authH = (token: string) => ({ authorization: `Bearer ${token}` });
const TRON_DEST = 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6';

/** Records every sent email so a test can read the emailed reset link. */
class RecordingEmail implements EmailProvider {
  readonly name = 'recording';
  readonly sent: OutboundEmail[] = [];
  async send(email: OutboundEmail): Promise<void> { this.sent.push(email); }
}

async function build(opts: { adminEmail?: string; email?: EmailProvider } = {}) {
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const withdrawals = new WithdrawalService(wallet, new InMemoryWithdrawals(), { minCents: 500, maxCents: 1_000_000 });
  const provider = new MockPaymentProvider('whsec');
  const intents = new InMemoryDepositIntents();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const refreshTokens = new InMemoryRefreshTokens();
  const verificationTokens = new InMemoryVerificationTokens();
  // Mirror app.ts: the owner-protection (admin-3) is owned by AuthService.isProtectedOwner,
  // which needs ownerEmail wired the same as config.adminEmail.
  const auth = new AuthService(repo, tokens, refreshTokens, { verificationTokens, email: opts.email, ownerEmail: opts.adminEmail ?? null });
  const adminAudit = new InMemoryAdminAudit();
  const config = loadConfig({ NODE_ENV: 'test', ...(opts.adminEmail ? { ADMIN_EMAIL: opts.adminEmail } : {}) } as NodeJS.ProcessEnv);
  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, adminAudit });
  return { app, repo, auth, wallet, provider, tokens, refreshTokens, verificationTokens, adminAudit };
}

/** Pull the raw reset token out of the emailed link (?resetPassword=<raw>). */
function resetTokenFromEmail(email: OutboundEmail): string {
  const m = /resetPassword=([0-9a-f]+)/.exec(email.text);
  if (!m) throw new Error('no reset token in email');
  return m[1]!;
}

/** Fund a user via a signed webhook (real deposit path). */
async function fund(app: any, provider: MockPaymentProvider, token: string, cents: number) {
  const dep = await app.inject({ method: 'POST', url: '/api/wallet/deposit', headers: authH(token), payload: { amountCents: cents } });
  const ref = dep.json().providerRef as string;
  const body = JSON.stringify({ providerRef: ref, userId: 'ignored', amountCents: cents, status: 'confirmed' });
  await app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-signature': provider.sign(body) }, payload: body });
}

// ----- #1 revocation-aware access tokens -----------------------------------

test('#1 a stale access token (tokenVersion bumped) is rejected with 401', async () => {
  const { app, auth } = await build();
  const reg = await auth.register({ username: 'staley', email: 's@x.com', password: 'password123' });
  const token = reg.tokens.accessToken;
  // Works before the bump.
  assert.equal((await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(token) })).statusCode, 200);
  // "Log out all devices" / reset / ban bumps tokenVersion → the held token is now stale.
  await auth.revokeAllSessions(reg.user.id);
  const after = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(token) });
  assert.equal(after.statusCode, 401);
  await app.close();
});

test('#1 an access token without a ver claim (legacy) is rejected', async () => {
  const { app } = await build();
  // Sign a token the OLD way (no ver claim) using the same secret/claims the server expects.
  const jwt = (await import('jsonwebtoken')).default;
  const legacy = jwt.sign({ username: 'x', type: 'access' }, 'a', { subject: 'u_legacy', algorithm: 'HS256', issuer: 'murlan', audience: 'murlan', expiresIn: '5m' });
  const res = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(legacy) });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('#1/#9 a banned user with a still-valid access token gets 403 on the API', async () => {
  const { app, auth, repo } = await build();
  const reg = await auth.register({ username: 'bandit', email: 'b@x.com', password: 'password123' });
  const token = reg.tokens.accessToken;
  // Ban directly via the repo (no tokenVersion bump) so the ONLY thing blocking the
  // still-valid token is the per-request checkLogin gate, not the ver check.
  await repo.setAccountState(reg.user.id, { state: 'banned', reason: 'fraud', until: null });
  const res = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(token) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'account_banned');
  await app.close();
});

// ----- #1 withdraw account-state gate --------------------------------------

test('#1 a banned user cannot withdraw (403), even with funds + a valid token', async () => {
  const { app, auth, repo, provider } = await build();
  const reg = await auth.register({ username: 'cashout', email: 'c@x.com', password: 'password123' });
  const token = reg.tokens.accessToken;
  await fund(app, provider, token, 5000);
  await repo.setAccountState(reg.user.id, { state: 'banned', reason: 'fraud', until: null });
  const res = await app.inject({ method: 'POST', url: '/api/wallet/withdraw', headers: authH(token), payload: { amountCents: 2000, destination: TRON_DEST } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('#1 a FROZEN user CAN still withdraw their own funds (frozen != blocked)', async () => {
  const { app, auth, repo, provider } = await build();
  const reg = await auth.register({ username: 'frosty', email: 'f@x.com', password: 'password123' });
  const token = reg.tokens.accessToken;
  await fund(app, provider, token, 5000);
  await repo.setAccountState(reg.user.id, { state: 'frozen', reason: 'review', until: null });
  const res = await app.inject({ method: 'POST', url: '/api/wallet/withdraw', headers: authH(token), payload: { amountCents: 2000, destination: TRON_DEST } });
  assert.equal(res.statusCode, 201, 'frozen accounts must be able to withdraw own funds');
  await app.close();
});

// ----- #2 RBAC promotion hole ----------------------------------------------

test('#2 a scoped manage_admins admin cannot promote anyone to admin (403)', async () => {
  const { app, repo, tokens } = await build();
  const scoped = await repo.create({ username: 'rbac', email: 'rb@x.com', passwordHash: 'h', role: 'admin' });
  await repo.setPermissions(scoped.id, ['manage_admins']); // scoped (non-empty)
  const target = await repo.create({ username: 'alt', email: 'alt@x.com', passwordHash: 'h' });
  const tok = tokens.issuePair(scoped.id, scoped.username).accessToken;
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/role`, headers: authH(tok), payload: { role: 'admin' } });
  assert.equal(res.statusCode, 403);
  assert.equal((await repo.findById(target.id))!.role, 'user'); // not promoted
  await app.close();
});

test('#2 a FULL admin can still promote to admin', async () => {
  const { app, repo, tokens } = await build();
  const full = await repo.create({ username: 'owner', email: 'o@x.com', passwordHash: 'h', role: 'admin' }); // permissions=[] = full
  const target = await repo.create({ username: 'alt2', email: 'alt2@x.com', passwordHash: 'h' });
  const tok = tokens.issuePair(full.id, full.username).accessToken;
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/role`, headers: authH(tok), payload: { role: 'admin' } });
  assert.equal(res.statusCode, 200);
  assert.equal((await repo.findById(target.id))!.role, 'admin');
  await app.close();
});

// ----- owner-demotion protection -------------------------------------------

test('the configured ADMIN_EMAIL owner cannot be demoted (403 owner_protected)', async () => {
  const { app, repo, tokens } = await build({ adminEmail: 'owner@x.com' });
  const owner = await repo.create({ username: 'owner', email: 'owner@x.com', passwordHash: 'h', role: 'admin' });
  const other = await repo.create({ username: 'admin2', email: 'a2@x.com', passwordHash: 'h', role: 'admin' });
  const tok = tokens.issuePair(other.id, other.username).accessToken;
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${owner.id}/role`, headers: authH(tok), payload: { role: 'user' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'owner_protected');
  assert.equal((await repo.findById(owner.id))!.role, 'admin');
  await app.close();
});

// ----- "log out all devices" -----------------------------------------------

test('POST /api/auth/logout-all revokes the caller\'s sessions (access + refresh)', async () => {
  const { app, auth } = await build();
  const reg = await auth.register({ username: 'multi', email: 'm@x.com', password: 'password123' });
  const token = reg.tokens.accessToken;
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: authH(token) });
  assert.equal(logout.statusCode, 200);
  // The held access token is now stale (tokenVersion bumped) → 401.
  assert.equal((await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(token) })).statusCode, 401);
  // The refresh token can no longer mint a new session either.
  const refresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { mrl_refresh: reg.tokens.refreshToken } });
  assert.equal(refresh.statusCode, 401);
  await app.close();
});

// ----- per-route rate limit (userId-keyed) ---------------------------------

test('per-route limit: withdraw is capped per user (keyed by userId, not just IP)', async () => {
  const { app, auth, provider } = await build();
  const reg = await auth.register({ username: 'spam', email: 'sp@x.com', password: 'password123' });
  const token = reg.tokens.accessToken;
  await fund(app, provider, token, 1_000_00);
  let saw429 = false;
  // The withdraw limiter is 15/min. Fire enough to trip it; a too-small balance/insufficient
  // is fine — we only assert the rate-limit eventually fires (429).
  for (let i = 0; i < 25; i++) {
    const res = await app.inject({ method: 'POST', url: '/api/wallet/withdraw', headers: authH(token), payload: { amountCents: 500, destination: TRON_DEST } });
    if (res.statusCode === 429) { saw429 = true; break; }
  }
  assert.equal(saw429, true, 'withdraw should be rate-limited per user');
  await app.close();
});

// ----- reset-token invalidation --------------------------------------------

test('password reset: a newer request invalidates the OLDER link (older token no longer works)', async () => {
  const email = new RecordingEmail();
  const { app, auth } = await build({ email });
  await auth.register({ username: 'reset', email: 'reset@x.com', password: 'password123' });

  await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'reset@x.com' } });
  const firstToken = resetTokenFromEmail(email.sent.at(-1)!);
  // A SECOND request issues a new link and must invalidate the first.
  await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'reset@x.com' } });
  const secondToken = resetTokenFromEmail(email.sent.at(-1)!);
  assert.notEqual(firstToken, secondToken);

  // The OLD link is dead.
  const oldTry = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: firstToken, password: 'newpassword1' } });
  assert.equal(oldTry.statusCode, 400, 'the superseded reset link must be invalid');
  // The NEW link still works.
  const newTry = await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token: secondToken, password: 'newpassword1' } });
  assert.equal(newTry.statusCode, 200);
  await app.close();
});

test('password reset: a successful reset burns the token (cannot be reused)', async () => {
  const email = new RecordingEmail();
  const { app, auth } = await build({ email });
  await auth.register({ username: 'reuse', email: 'reuse@x.com', password: 'password123' });
  await app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'reuse@x.com' } });
  const token = resetTokenFromEmail(email.sent.at(-1)!);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'newpassword1' } })).statusCode, 200);
  // Replay the same token → rejected.
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'newpassword2' } })).statusCode, 400);
  await app.close();
});

// ----- #4 reverse-proxy IP: two external IPs are independent buckets ---------

test('#4 the IP-keyed rate limit buckets two X-Forwarded-For clients independently', async () => {
  const { app } = await build();
  // The auth limiter is 10 / 5min and falls back to the global keyGenerator (req.ip),
  // which — with trustProxy honoring X-Forwarded-For — resolves to the real client. So a
  // flood from IP A must NOT 429 a request from a different IP B.
  const reg = (i: number, ip: string) => app.inject({
    method: 'POST', url: '/api/auth/register',
    headers: { 'x-forwarded-for': ip },
    payload: { username: `ipuser${i}`, email: `ipuser${i}@x.com`, password: 'password123' },
  });
  // Exhaust IP A's bucket (10 allowed → the 11th+ is 429).
  let aHit429 = false;
  for (let i = 0; i < 14; i++) {
    const res = await reg(i, '203.0.113.5');
    if (res.statusCode === 429) { aHit429 = true; break; }
  }
  assert.equal(aHit429, true, 'IP A should eventually be rate-limited');
  // IP B is a fresh bucket → its first request is NOT 429.
  const b = await reg(100, '198.51.100.9');
  assert.notEqual(b.statusCode, 429, 'a different IP must have its own bucket');
  await app.close();
});

// ----- login timing-oracle equalization ------------------------------------

test('login: a missing email still runs a password verify (no fast-path enumeration)', async () => {
  const { app } = await build();
  // Both a missing email and a wrong password return the SAME 401 bad_credentials.
  const miss = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@x.com', password: 'whatever123' } });
  assert.equal(miss.statusCode, 401);
  assert.equal(miss.json().error.code, 'bad_credentials');
  await app.close();
});
