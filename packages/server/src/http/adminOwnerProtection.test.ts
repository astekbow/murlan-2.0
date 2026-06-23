// ============================================================================
// #3 — Admin owner-protection (admin-1/2/3)
// ----------------------------------------------------------------------------
// The configured OWNER (ADMIN_EMAIL) must be un-bannable / un-suspendable, their KYC
// and permissions un-mutable, and a scoped admin must not be able to demote/neuter a
// FULL admin. Plus: the owner is exempt from the login account-state gate, and boot
// resets the owner's permissions to [] (full).
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService, AuthError } from '../auth/authService.ts';
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryWithdrawals, WithdrawalService } from '../money/withdrawals.ts';
import { MockPaymentProvider } from '../money/paymentProvider.ts';
import { InMemoryDepositIntents } from '../money/depositIntents.ts';
import { InMemoryAdminAudit } from '../auth/adminAudit.ts';

const OWNER_EMAIL = 'owner@x.com';

async function build() {
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const withdrawals = new WithdrawalService(wallet, new InMemoryWithdrawals());
  const provider = new MockPaymentProvider('whsec');
  const intents = new InMemoryDepositIntents();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens, undefined, { ownerEmail: OWNER_EMAIL });
  const adminAudit = new InMemoryAdminAudit();
  // adminEmail drives the route guard; ownerEmail drives the AuthService backstop — keep them aligned.
  const config = { ...loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), adminEmail: OWNER_EMAIL };
  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, adminAudit });

  const owner = await repo.create({ username: 'owner', email: OWNER_EMAIL, passwordHash: 'h', role: 'admin' });
  const tokenFor = (id: string, name: string) => tokens.issuePair(id, name).accessToken;
  return { app, repo, auth, ledger, wallet, ownerId: owner.id, tokenFor };
}

const authH = (token: string) => ({ authorization: `Bearer ${token}` });

/** A SCOPED admin holding `manage_accounts` + `manage_admins` (enough to call the routes). */
async function scopedAdmin(repo: InMemoryUserRepository, tokenFor: (id: string, n: string) => string) {
  const a = await repo.create({ username: 'scoped', email: 'sc@x.com', passwordHash: 'h', role: 'admin' });
  await repo.setPermissions(a.id, ['manage_accounts', 'manage_admins']);
  return { id: a.id, token: tokenFor(a.id, a.username) };
}

test('scoped admin BANNING the owner → 403 owner_protected', async () => {
  const { app, repo, ownerId, tokenFor } = await build();
  const sc = await scopedAdmin(repo, tokenFor);
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${ownerId}/account-state`, headers: authH(sc.token), payload: { state: 'banned' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'owner_protected');
  await app.close();
});

test('scoped admin SUSPENDING the owner → 403 owner_protected', async () => {
  const { app, repo, ownerId, tokenFor } = await build();
  const sc = await scopedAdmin(repo, tokenFor);
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${ownerId}/account-state`, headers: authH(sc.token), payload: { state: 'suspended', durationMs: 1000 } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'owner_protected');
  await app.close();
});

test('scoped admin changing the owner KYC → 403 owner_protected', async () => {
  const { app, repo, ownerId, tokenFor } = await build();
  const sc = await scopedAdmin(repo, tokenFor);
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${ownerId}/kyc`, headers: authH(sc.token), payload: { status: 'none' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'owner_protected');
  await app.close();
});

test('scoped admin STRIPPING the owner permissions → 403 owner_protected', async () => {
  const { app, repo, ownerId, tokenFor } = await build();
  const sc = await scopedAdmin(repo, tokenFor);
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${ownerId}/permissions`, headers: authH(sc.token), payload: { permissions: ['view_revenue'] } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'owner_protected');
  await app.close();
});

test('scoped admin cannot DEMOTE or NEUTER a FULL (peer) admin', async () => {
  const { app, repo, tokenFor } = await build();
  const sc = await scopedAdmin(repo, tokenFor);
  const fullPeer = await repo.create({ username: 'peer', email: 'peer@x.com', passwordHash: 'h', role: 'admin' }); // permissions [] = full
  const demote = await app.inject({ method: 'POST', url: `/api/admin/users/${fullPeer.id}/role`, headers: authH(sc.token), payload: { role: 'user' } });
  assert.equal(demote.statusCode, 403);
  const neuter = await app.inject({ method: 'POST', url: `/api/admin/users/${fullPeer.id}/permissions`, headers: authH(sc.token), payload: { permissions: ['view_revenue'] } });
  assert.equal(neuter.statusCode, 403);
  await app.close();
});

test('a FULL admin CAN ban a non-owner user (owner-protection does not over-block)', async () => {
  const { app, repo, ownerId, tokenFor } = await build();
  const victim = await repo.create({ username: 'victim', email: 'v@x.com', passwordHash: 'h', role: 'user' });
  const ownerToken = tokenFor(ownerId, 'owner');
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${victim.id}/account-state`, headers: authH(ownerToken), payload: { state: 'banned' } });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('owner is EXEMPT from the login account-state gate (a stray ban cannot lock them out)', async () => {
  const repo = new InMemoryUserRepository();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens, undefined, { ownerEmail: OWNER_EMAIL });
  // Register the owner with a known password, then force a ban directly on the repo.
  const reg = await auth.register({ username: 'owner', email: OWNER_EMAIL, password: 'password123' });
  await repo.setAccountState(reg.user.id, { state: 'banned', reason: 'oops', until: null });
  // A normal banned user would throw on login; the owner still logs in.
  const ok = await auth.login({ email: OWNER_EMAIL, password: 'password123' });
  assert.equal(ok.user.id, reg.user.id);
  // checkLogin also reports allowed for the owner despite the ban.
  assert.equal((await auth.checkLogin(reg.user.id)).allowed, true);
  // A non-owner banned account is still blocked.
  const other = await auth.register({ username: 'joe', email: 'joe@x.com', password: 'password123' });
  await repo.setAccountState(other.user.id, { state: 'banned', reason: 'x', until: null });
  await assert.rejects(auth.login({ email: 'joe@x.com', password: 'password123' }), (e: unknown) => e instanceof AuthError);
});

test('isProtectedOwner is true only for the configured owner', async () => {
  const { repo, auth, ownerId } = await build();
  assert.equal(await auth.isProtectedOwner(ownerId), true);
  const other = await repo.create({ username: 'nobody', email: 'n@x.com', passwordHash: 'h', role: 'admin' });
  assert.equal(await auth.isProtectedOwner(other.id), false);
});
