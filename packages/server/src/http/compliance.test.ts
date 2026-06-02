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
import { ComplianceService } from '../compliance/complianceService.ts';

async function build(env: Record<string, string> = {}) {
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const withdrawals = new WithdrawalService(wallet, new InMemoryWithdrawals());
  const provider = new MockPaymentProvider('whsec');
  const intents = new InMemoryDepositIntents();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens);
  const config = loadConfig({ NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv);
  const compliance = new ComplianceService(config.compliance);
  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, compliance });

  const reg = await auth.register({ username: 'lojtar', email: 'l@x.com', password: 'password123' });
  const admin = await repo.create({ username: 'admin', email: 'a@x.com', passwordHash: 'h', role: 'admin' });
  const adminToken = tokens.issuePair(admin.id, admin.username).accessToken;
  return { app, userId: reg.user.id, userToken: reg.tokens.accessToken, adminToken };
}
const authH = (token: string) => ({ authorization: `Bearer ${token}` });

test('with compliance OFF, deposits are not gated', async () => {
  const { app, userToken } = await build(); // all flags off by default
  const res = await app.inject({ method: 'POST', url: '/api/wallet/deposit', headers: authH(userToken), payload: { amountCents: 5000 } });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('with KYC required, a deposit is blocked until an admin verifies the user', async () => {
  const { app, userId, userToken, adminToken } = await build({ KYC_REQUIRED: 'true' });

  const blocked = await app.inject({ method: 'POST', url: '/api/wallet/deposit', headers: authH(userToken), payload: { amountCents: 5000 } });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error.code, 'kyc_required');

  // Admin verifies KYC.
  const kyc = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/kyc`, headers: authH(adminToken), payload: { status: 'verified' } });
  assert.equal(kyc.statusCode, 200);
  assert.equal(kyc.json().user.role, 'user');

  const allowed = await app.inject({ method: 'POST', url: '/api/wallet/deposit', headers: authH(userToken), payload: { amountCents: 5000 } });
  assert.equal(allowed.statusCode, 200);
  await app.close();
});

test('admin KYC route is admin-only', async () => {
  const { app, userId, userToken } = await build({ KYC_REQUIRED: 'true' });
  const forbidden = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/kyc`, headers: authH(userToken), payload: { status: 'verified' } });
  assert.equal(forbidden.statusCode, 403);
  await app.close();
});

test('account self-service: set profile and self-exclude', async () => {
  const { app, userToken } = await build();
  const prof = await app.inject({ method: 'POST', url: '/api/account/profile', headers: authH(userToken), payload: { dateOfBirth: '2000-05-01', country: 'al' } });
  assert.equal(prof.statusCode, 200);

  const me = await app.inject({ method: 'GET', url: '/api/account', headers: authH(userToken) });
  assert.equal(me.json().profile.dateOfBirth, '2000-05-01');
  assert.equal(me.json().profile.country, 'AL');

  const excl = await app.inject({ method: 'POST', url: '/api/account/self-exclude', headers: authH(userToken), payload: { days: 30 } });
  assert.equal(excl.statusCode, 200);
  assert.ok(excl.json().selfExcludedUntil > Date.now());
  await app.close();
});

test('self-exclusion can only be extended, never shortened', async () => {
  const { app, userToken } = await build();
  const long = await app.inject({ method: 'POST', url: '/api/account/self-exclude', headers: authH(userToken), payload: { days: 365 } });
  const until365 = long.json().selfExcludedUntil as number;
  // Attempt to shorten to 1 day — must NOT reduce the existing exclusion.
  const short = await app.inject({ method: 'POST', url: '/api/account/self-exclude', headers: authH(userToken), payload: { days: 1 } });
  assert.equal(short.json().selfExcludedUntil, until365);
  await app.close();
});

test('with KYC required, withdrawals are gated just like deposits', async () => {
  const { app, userToken } = await build({ KYC_REQUIRED: 'true' });
  const res = await app.inject({ method: 'POST', url: '/api/wallet/withdraw', headers: authH(userToken), payload: { amountCents: 1000, destination: 'addr-123' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'kyc_required');
  await app.close();
});

test('with responsible-gaming on, a self-excluded user is blocked from depositing', async () => {
  const { app, userToken } = await build({ RESPONSIBLE_GAMING: 'true' });
  await app.inject({ method: 'POST', url: '/api/account/self-exclude', headers: authH(userToken), payload: { days: 30 } });
  const res = await app.inject({ method: 'POST', url: '/api/wallet/deposit', headers: authH(userToken), payload: { amountCents: 5000 } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'self_excluded');
  await app.close();
});
