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
  const admin = await repo.create({ username: 'admin', email: 'a@x.com', passwordHash: 'h', role: 'admin' });
  const adminToken = tokens.issuePair(admin.id, admin.username).accessToken;
  return { app, repo, wallet, auth, adminId: admin.id, userId: user.user.id, userToken: user.tokens.accessToken, adminToken };
}

const authH = (token: string) => ({ authorization: `Bearer ${token}` });

test('admin routes reject a non-admin caller (403)', async () => {
  const { app, userId, userToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(userToken), payload: { deltaCents: 100, reason: 'x' } });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('balance adjust credits the user and writes an audited action', async () => {
  const { app, wallet, userId, adminId, adminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(adminToken), payload: { deltaCents: 2500, reason: 'goodwill' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().balanceCents, 2500);
  assert.equal(await wallet.getBalance(userId), 2500);

  const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: authH(adminToken) });
  const actions = audit.json().actions as Array<{ action: string; adminId: string; targetUserId: string; amountCents: number; detail: string }>;
  const rec = actions.find((a) => a.action === 'balance_adjust');
  assert.ok(rec, 'balance_adjust audited');
  assert.equal(rec!.adminId, adminId);
  assert.equal(rec!.targetUserId, userId);
  assert.equal(rec!.amountCents, 2500);
  assert.equal(rec!.detail, 'goodwill');
  await app.close();
});

test('KYC set updates the user and is audited', async () => {
  const { app, repo, userId, adminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/kyc`, headers: authH(adminToken), payload: { status: 'verified' } });
  assert.equal(res.statusCode, 200);
  assert.equal((await repo.findById(userId))!.kycStatus, 'verified');
  const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', headers: authH(adminToken) })).json().actions as Array<{ action: string; detail: string }>;
  assert.ok(audit.some((a) => a.action === 'kyc_set' && a.detail === 'verified'));
  await app.close();
});

test('account-state ban updates state, revokes sessions, and is audited', async () => {
  const { app, repo, auth, userId, adminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/account-state`, headers: authH(adminToken), payload: { state: 'banned', reason: 'collusion' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().accountState.state, 'banned');
  assert.equal((await repo.findById(userId))!.accountState, 'banned');

  // A banned account can no longer log in.
  await assert.rejects(() => auth.login({ email: 'l@x.com', password: 'password123' }), (e) => (e as { code?: string }).code === 'account_banned');

  const audit = (await app.inject({ method: 'GET', url: '/api/admin/audit', headers: authH(adminToken) })).json().actions as Array<{ action: string; detail: string }>;
  assert.ok(audit.some((a) => a.action === 'account_state_set' && /banned/.test(a.detail)));
  await app.close();
});

test('account-state validation rejects an unknown state (400)', async () => {
  const { app, userId, adminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/account-state`, headers: authH(adminToken), payload: { state: 'nonsense' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('revenue breakdown reports rake + payout liability (read-only)', async () => {
  const { app, wallet, userId, adminToken } = await build();
  // Give the player a balance (the house's outstanding liability) and book rake.
  await wallet.adminAdjust(userId, 5000, 'seed');
  await wallet.recordRake(300, { matchId: 'm1', providerRef: 'rake:m1' });
  await wallet.recordRake(200, { matchId: 'm2', providerRef: 'rake:m2' });

  const res = await app.inject({ method: 'GET', url: '/api/admin/revenue/breakdown', headers: authH(adminToken) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { totalRakeCents: number; rakeCount: number; payoutLiabilityCents: number; byDay: unknown[]; byType: unknown[] };
  assert.equal(body.totalRakeCents, 500);
  assert.equal(body.rakeCount, 2);
  assert.equal(body.payoutLiabilityCents, 5000); // the credited player balance
  assert.ok(Array.isArray(body.byDay) && Array.isArray(body.byType));
  await app.close();
});
