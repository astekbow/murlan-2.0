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

test('revenue breakdown reports rake + payout liability (players only, read-only)', async () => {
  const { app, wallet, userId, adminId, adminToken } = await build();
  // Give the player a balance (the house's outstanding liability) and book rake.
  await wallet.adminAdjust(userId, 5000, 'seed');
  await wallet.adminAdjust(adminId, 1000, 'staff'); // admin balance must NOT count as player liability
  await wallet.recordRake(300, { matchId: 'm1', providerRef: 'rake:m1' });
  await wallet.recordRake(200, { matchId: 'm2', providerRef: 'rake:m2' });

  const res = await app.inject({ method: 'GET', url: '/api/admin/revenue/breakdown', headers: authH(adminToken) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { totalRakeCents: number; rakeCount: number; payoutLiabilityCents: number; byDay: unknown[]; byType: unknown[] };
  assert.equal(body.totalRakeCents, 500);
  assert.equal(body.rakeCount, 2);
  assert.equal(body.payoutLiabilityCents, 5000); // only the player's balance, not the admin's 1000
  assert.ok(Array.isArray(body.byDay) && Array.isArray(body.byType));
  await app.close();
});

// ===== admin-6: manual balance-adjust governance ============================

test('adjust OVER the per-call ceiling is rejected (schema 400)', async () => {
  const { app, userId, adminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(adminToken), payload: { deltaCents: 5_000_01, reason: 'too big' } });
  assert.equal(res.statusCode, 400); // > $5,000 fails the schema bound
  await app.close();
});

test('adjust over the per-ADMIN rolling-24h cap is rejected (422 over_daily_cap)', async () => {
  const { app, userId, adminToken } = await build();
  const url = `/api/admin/users/${userId}/adjust`;
  // 4 × $5,000 = $20,000 (exactly the cap) all succeed; the 5th breaches → 422.
  for (let i = 0; i < 4; i++) {
    const ok = await app.inject({ method: 'POST', url, headers: authH(adminToken), payload: { deltaCents: 5_000_00, reason: `batch ${i}` } });
    assert.equal(ok.statusCode, 200);
  }
  const over = await app.inject({ method: 'POST', url, headers: authH(adminToken), payload: { deltaCents: 100, reason: 'one more' } });
  assert.equal(over.statusCode, 422);
  assert.equal(over.json().error.code, 'over_daily_cap');
  await app.close();
});

test('CONCURRENT adjusts cannot bypass the rolling-24h cap (TOCTOU serialized)', async () => {
  const { app, wallet, userId, adminToken } = await build();
  const url = `/api/admin/users/${userId}/adjust`;
  // Fire 6 × $5,000 = $30,000 ALL AT ONCE. Without per-admin serialization they'd each read the
  // same stale $0 pre-commit total and all 6 would pass, crediting $30k — $10k over the $20k cap.
  // Serialized, exactly 4 fit the cap ($20k) and the rest are rejected.
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      app.inject({ method: 'POST', url, headers: authH(adminToken), payload: { deltaCents: 5_000_00, reason: `race ${i}` } }),
    ),
  );
  const ok = results.filter((r) => r.statusCode === 200).length;
  const over = results.filter((r) => r.statusCode === 422).length;
  assert.equal(ok, 4, 'exactly 4 × $5,000 fit under the $20,000 cap');
  assert.equal(over, 2, 'the 2 over-cap adjusts are rejected');
  // The money-safety invariant: credited balance never exceeds the cap.
  assert.equal(await wallet.getBalance(userId), 2_000_000);
  await app.close();
});

test('revenue reports total rake + count via aggregates (no full-ledger scan)', async () => {
  const { app, wallet, adminToken } = await build();
  await wallet.recordRake(300, { matchId: 'm1', providerRef: 'rake:m1' });
  await wallet.recordRake(200, { matchId: 'm2', providerRef: 'rake:m2' });
  const res = await app.inject({ method: 'GET', url: '/api/admin/revenue', headers: authH(adminToken) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { totalRakeCents: number; rakeCount: number };
  assert.equal(body.totalRakeCents, 500);
  assert.equal(body.rakeCount, 2);
  await app.close();
});

test('an admin CANNOT credit their OWN account (self_credit, 403)', async () => {
  const { app, adminId, adminToken } = await build();
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${adminId}/adjust`, headers: authH(adminToken), payload: { deltaCents: 1000, reason: 'self top-up' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'self_credit');
  await app.close();
});

test('an admin CAN debit their own account (only self-CREDIT is blocked)', async () => {
  const { app, wallet, adminId, adminToken } = await build();
  await wallet.adminAdjust(adminId, 2000, 'seed'); // give the admin a balance to debit (seed bypasses the route)
  const res = await app.inject({ method: 'POST', url: `/api/admin/users/${adminId}/adjust`, headers: authH(adminToken), payload: { deltaCents: -500, reason: 'correction' } });
  assert.equal(res.statusCode, 200);
  await app.close();
});
