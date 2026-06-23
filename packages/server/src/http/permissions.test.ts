import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryWithdrawals, WithdrawalService } from '../money/withdrawals.ts';
import { MockPaymentProvider } from '../money/paymentProvider.ts';
import { InMemoryDepositIntents } from '../money/depositIntents.ts';
import { InMemoryAdminAudit } from '../auth/adminAudit.ts';
import { hasPermission, isAdminPermission } from './permissions.ts';

async function build() {
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const withdrawals = new WithdrawalService(wallet, new InMemoryWithdrawals());
  const provider = new MockPaymentProvider('whsec');
  const intents = new InMemoryDepositIntents();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens);
  const adminAudit = new InMemoryAdminAudit();
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, adminAudit });

  const user = await auth.register({ username: 'lojtar', email: 'l@x.com', password: 'password123' });
  const fullAdmin = await repo.create({ username: 'owner', email: 'o@x.com', passwordHash: 'h', role: 'admin' });
  const tokenFor = (id: string, name: string) => tokens.issuePair(id, name).accessToken;
  return { app, repo, userId: user.user.id, fullAdminId: fullAdmin.id, fullAdminToken: tokenFor(fullAdmin.id, fullAdmin.username), tokenFor };
}

const authH = (token: string) => ({ authorization: `Bearer ${token}` });

// ----- pure RBAC logic -----------------------------------------------------
test('hasPermission: an empty grant means FULL admin (backward-compatible)', () => {
  assert.equal(hasPermission([], 'adjust_balance'), true);
  assert.equal(hasPermission(undefined, 'void_matches'), true);
});

test('hasPermission: a scoped grant only allows the listed scopes', () => {
  assert.equal(hasPermission(['view_revenue'], 'view_revenue'), true);
  assert.equal(hasPermission(['view_revenue'], 'adjust_balance'), false);
});

test('isAdminPermission rejects unknown scope strings', () => {
  assert.equal(isAdminPermission('adjust_balance'), true);
  assert.equal(isAdminPermission('hack_everything'), false);
});

// ----- route-level gating --------------------------------------------------
test('a full admin (no scopes) can still adjust a balance', async () => {
  const { app, userId, fullAdminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(fullAdminToken), payload: { deltaCents: 100, reason: 'x' } });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('a scoped admin is 403 outside its scope, 200 once granted', async () => {
  const { app, repo, userId, tokenFor } = await build();
  const a = await repo.create({ username: 'support', email: 's@x.com', passwordHash: 'h', role: 'admin' });
  await repo.setPermissions(a.id, ['view_revenue']); // no adjust_balance
  const tok = tokenFor(a.id, a.username);

  const deny = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(tok), payload: { deltaCents: 100, reason: 'x' } });
  assert.equal(deny.statusCode, 403);

  await repo.setPermissions(a.id, ['view_revenue', 'adjust_balance']);
  const allow = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(tok), payload: { deltaCents: 100, reason: 'x' } });
  assert.equal(allow.statusCode, 200);
  await app.close();
});

test('setPermissions: scopes another admin, drops unknown scopes, and is audited', async () => {
  const { app, repo, fullAdminToken } = await build();
  const a = await repo.create({ username: 'mod', email: 'm@x.com', passwordHash: 'h', role: 'admin' });
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${a.id}/permissions`, headers: authH(fullAdminToken), payload: { permissions: ['moderate_chat', 'totally_fake'] } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((await repo.findById(a.id))!.permissions, ['moderate_chat']);

  const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', headers: authH(fullAdminToken) })).json().actions as Array<{ action: string }>;
  assert.ok(audit.some((x) => x.action === 'permissions_set'), 'permissions_set audited');
  await app.close();
});

test('you cannot restrict your OWN permissions (self_scope, 400)', async () => {
  const { app, fullAdminId, fullAdminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${fullAdminId}/permissions`, headers: authH(fullAdminToken), payload: { permissions: ['view_revenue'] } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'self_scope');
  await app.close();
});

test('a scoped admin lacking manage_admins cannot assign permissions (403)', async () => {
  const { app, repo, tokenFor } = await build();
  const scoped = await repo.create({ username: 'support2', email: 's2@x.com', passwordHash: 'h', role: 'admin' });
  await repo.setPermissions(scoped.id, ['view_revenue']);
  const target = await repo.create({ username: 'targ', email: 't@x.com', passwordHash: 'h', role: 'admin' });
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/permissions`, headers: authH(tokenFor(scoped.id, scoped.username)), payload: { permissions: ['moderate_chat'] } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('anti-escalation: a manage_admins-only admin cannot grant scopes it lacks or mint a full admin', async () => {
  const { app, repo, tokenFor } = await build();
  const scopedAdmin = await repo.create({ username: 'rbadmin', email: 'rb@x.com', passwordHash: 'h', role: 'admin' });
  await repo.setPermissions(scopedAdmin.id, ['manage_admins']); // ONLY manage_admins
  // The target is already a SCOPED admin (not a full one) — a scoped caller may only touch
  // scoped admins (admin-2: it can NEVER mutate a FULL admin's permissions; see below test).
  const target = await repo.create({ username: 'tgt', email: 'tg@x.com', passwordHash: 'h', role: 'admin' });
  await repo.setPermissions(target.id, ['moderate_chat']); // make it scoped, not full
  const tok = tokenFor(scopedAdmin.id, scopedAdmin.username);

  // Cannot grant a scope it does not hold.
  const denyEscalate = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/permissions`, headers: authH(tok), payload: { permissions: ['adjust_balance'] } });
  assert.equal(denyEscalate.statusCode, 403);
  // Cannot mint a FULL admin (empty list = all powers).
  const denyFull = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/permissions`, headers: authH(tok), payload: { permissions: [] } });
  assert.equal(denyFull.statusCode, 403);
  // CAN grant a subset of what it holds (to a scoped, non-full admin).
  const ok = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/permissions`, headers: authH(tok), payload: { permissions: ['manage_admins'] } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual((await repo.findById(target.id))!.permissions, ['manage_admins']);
  await app.close();
});

test('admin-2: a SCOPED admin cannot mutate the permissions of a FULL (peer) admin', async () => {
  const { app, repo, tokenFor } = await build();
  const scopedAdmin = await repo.create({ username: 'rbadmin2', email: 'rb2@x.com', passwordHash: 'h', role: 'admin' });
  await repo.setPermissions(scopedAdmin.id, ['manage_admins']);
  const fullPeer = await repo.create({ username: 'fullpeer', email: 'fp@x.com', passwordHash: 'h', role: 'admin' }); // permissions [] = full
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${fullPeer.id}/permissions`, headers: authH(tokenFor(scopedAdmin.id, scopedAdmin.username)), payload: { permissions: ['manage_admins'] } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual((await repo.findById(fullPeer.id))!.permissions, []); // unchanged
  await app.close();
});

test('a full admin can still grant any scope, including full (empty)', async () => {
  const { app, repo, fullAdminToken } = await build();
  const target = await repo.create({ username: 'tgt2', email: 'tg2@x.com', passwordHash: 'h', role: 'admin' });
  const scoped = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/permissions`, headers: authH(fullAdminToken), payload: { permissions: ['adjust_balance'] } });
  assert.equal(scoped.statusCode, 200);
  const full = await app.inject({ method: 'POST', url: `/api/admin/users/${target.id}/permissions`, headers: authH(fullAdminToken), payload: { permissions: [] } });
  assert.equal(full.statusCode, 200);
  assert.deepEqual((await repo.findById(target.id))!.permissions, []);
  await app.close();
});
