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

async function build() {
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const withdrawals = new WithdrawalService(wallet, new InMemoryWithdrawals(), { minCents: 500, maxCents: 1_000_000 });
  const provider = new MockPaymentProvider('whsec');
  const intents = new InMemoryDepositIntents();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens);
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents });

  const reg = await auth.register({ username: 'lojtar', email: 'l@x.com', password: 'password123' });
  const admin = await repo.create({ username: 'admin', email: 'a@x.com', passwordHash: 'h', role: 'admin' });
  const adminToken = tokens.issuePair(admin.id, admin.username).accessToken;

  return { app, wallet, provider, userId: reg.user.id, userToken: reg.tokens.accessToken, adminToken };
}

const authH = (token: string) => ({ authorization: `Bearer ${token}` });

function webhook(provider: MockPaymentProvider, payload: object, sign = true) {
  const body = JSON.stringify(payload);
  return { body, sig: sign ? provider.sign(body) : 'bad' };
}

/** Create a deposit intent via the API and return its providerRef. */
async function startDeposit(app: any, token: string, amountCents: number): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/wallet/deposit', headers: authH(token), payload: { amountCents } });
  return res.json().providerRef as string;
}

test('GET /api/wallet requires auth and returns the balance', async () => {
  const { app, userToken } = await build();
  assert.equal((await app.inject({ method: 'GET', url: '/api/wallet' })).statusCode, 401);
  const ok = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(userToken) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().balanceCents, 0);
  await app.close();
});

test('signed webhook credits the depositor; a retry is idempotent', async () => {
  const { app, provider, userToken } = await build();
  const ref = await startDeposit(app, userToken, 5000);
  const { body, sig } = webhook(provider, { providerRef: ref, userId: 'someone-else', amountCents: 5000, status: 'confirmed' });

  const first = await app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().idempotent, false);
  assert.equal(first.json().balanceCents, 5000);

  const retry = await app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
  assert.equal(retry.json().idempotent, true);
  assert.equal(retry.json().balanceCents, 5000); // not 10000

  // Credited the DEPOSITOR (from the intent), not the body-supplied userId.
  const bal = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(userToken) });
  assert.equal(bal.json().balanceCents, 5000);
  await app.close();
});

test('webhook with a bad signature is rejected and credits nothing', async () => {
  const { app, provider, userToken } = await build();
  const ref = await startDeposit(app, userToken, 5000);
  const { body } = webhook(provider, { providerRef: ref, amountCents: 5000 }, false);
  const res = await app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-signature': 'bad' }, payload: body });
  assert.equal(res.statusCode, 400);
  const bal = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(userToken) });
  assert.equal(bal.json().balanceCents, 0);
  await app.close();
});

test('webhook for an unknown providerRef (no intent) is rejected — no minting', async () => {
  const { app, provider, userToken } = await build();
  const { body, sig } = webhook(provider, { providerRef: 'never_created', userId: userToken, amountCents: 9999, status: 'confirmed' });
  const res = await app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'unknown_payment');
  await app.close();
});

test('webhook reporting an amount different from the recorded intent is rejected', async () => {
  const { app, provider, userToken } = await build();
  const ref = await startDeposit(app, userToken, 5000);
  const { body, sig } = webhook(provider, { providerRef: ref, userId: 'x', amountCents: 5_000_000, status: 'confirmed' });
  const res = await app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'amount_mismatch');
  const bal = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(userToken) });
  assert.equal(bal.json().balanceCents, 0); // nothing minted
  await app.close();
});

test('POST /api/wallet/deposit returns a provider intent', async () => {
  const { app, userToken } = await build();
  const res = await app.inject({ method: 'POST', url: '/api/wallet/deposit', headers: authH(userToken), payload: { amountCents: 5000 } });
  assert.equal(res.statusCode, 200);
  assert.ok(typeof res.json().providerRef === 'string');
  assert.match(res.json().payAddress, /^mock:\/\//);
  await app.close();
});

test('withdrawal: request holds funds (201) or rejects insufficient (402); admin can approve', async () => {
  const { app, provider, userToken, adminToken } = await build();
  // fund $50 via a real deposit intent + webhook
  const ref = await startDeposit(app, userToken, 5000);
  const { body, sig } = webhook(provider, { providerRef: ref, userId: 'ignored-by-intent', amountCents: 5000, status: 'confirmed' });
  await app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-signature': sig }, payload: body });

  const tooMuch = await app.inject({ method: 'POST', url: '/api/wallet/withdraw', headers: authH(userToken), payload: { amountCents: 999999, destination: 'addr-123' } });
  assert.equal(tooMuch.statusCode, 402);

  const wd = await app.inject({ method: 'POST', url: '/api/wallet/withdraw', headers: authH(userToken), payload: { amountCents: 2000, destination: 'addr-123' } });
  assert.equal(wd.statusCode, 201);
  const balAfter = await app.inject({ method: 'GET', url: '/api/wallet', headers: authH(userToken) });
  assert.equal(balAfter.json().balanceCents, 3000); // held

  const wid = wd.json().withdrawal.id as string;
  const pending = await app.inject({ method: 'GET', url: '/api/admin/withdrawals', headers: authH(adminToken) });
  assert.equal(pending.json().withdrawals.length, 1);
  const approve = await app.inject({ method: 'POST', url: `/api/admin/withdrawals/${wid}/approve`, headers: authH(adminToken) });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().withdrawal.status, 'completed');
  await app.close();
});

test('admin can list users (with KYC) and active matches; non-admin is forbidden', async () => {
  const { app, userToken, adminToken } = await build();
  const forbidden = await app.inject({ method: 'GET', url: '/api/admin/users', headers: authH(userToken) });
  assert.equal(forbidden.statusCode, 403);

  const users = await app.inject({ method: 'GET', url: '/api/admin/users', headers: authH(adminToken) });
  assert.equal(users.statusCode, 200);
  assert.ok(Array.isArray(users.json().users));
  assert.ok(users.json().users.some((u: any) => u.username === 'lojtar' && 'kycStatus' in u && 'balanceCents' in u));

  // No RoomManager wired into this test app → matches list is empty (not an error).
  const matches = await app.inject({ method: 'GET', url: '/api/admin/matches', headers: authH(adminToken) });
  assert.equal(matches.statusCode, 200);
  assert.deepEqual(matches.json().matches, []);
  await app.close();
});

test('admin balance adjust is admin-only and writes to the ledger', async () => {
  const { app, userId, userToken, adminToken } = await build();
  // non-admin forbidden
  const forbidden = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(userToken), payload: { deltaCents: 1000, reason: 'x' } });
  assert.equal(forbidden.statusCode, 403);

  const ok = await app.inject({ method: 'POST', url: `/api/admin/users/${userId}/adjust`, headers: authH(adminToken), payload: { deltaCents: 2500, reason: 'manual top-up' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().balanceCents, 2500);

  const txs = await app.inject({ method: 'GET', url: '/api/wallet/transactions', headers: authH(userToken) });
  assert.ok(txs.json().transactions.some((t: any) => t.type === 'admin_adjust' && t.amountCents === 2500));
  await app.close();
});
