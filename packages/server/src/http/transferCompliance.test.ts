// ============================================================================
// #5 — P2P transfer compliance + daily cap (money-4/6)
// ----------------------------------------------------------------------------
// The transfer route runs the FULL real-money gate (account-state + compliance incl.
// self-exclusion) on BOTH parties when the compliance toggle is ON (no behavior change
// while OFF), and enforces a per-user 24h transfer-out cap when DAILY_TRANSFER_CAP_CENTS>0
// (0 = unlimited).
// ============================================================================

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
import { FriendsService } from '../social/friendsService.ts';
import { InMemoryFriends } from '../social/friendsRepository.ts';
import { Presence } from '../realtime/presence.ts';

const authH = (token: string) => ({ authorization: `Bearer ${token}` });

async function build(opts: { complianceOn?: boolean; dailyTransferCapCents?: number } = {}) {
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const withdrawals = new WithdrawalService(wallet, new InMemoryWithdrawals());
  const provider = new MockPaymentProvider('whsec');
  const intents = new InMemoryDepositIntents();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens);
  const friends = new FriendsService(repo, new InMemoryFriends(), new Presence());
  // RESPONSIBLE_GAMING on → compliance.enabled true → checkRealMoney honors self-exclusion.
  const compliance = new ComplianceService({ kycRequired: false, minAge: 0, blockedCountries: [], responsibleGaming: !!opts.complianceOn });
  const base = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const config = { ...base, dailyTransferCapCents: opts.dailyTransferCapCents ?? 0 };
  const app = await buildHttpApp({ auth, config, wallet, withdrawals, provider, intents, compliance, friends });

  const a = await auth.register({ username: 'sender', email: 's@x.com', password: 'password123' });
  const b = await auth.register({ username: 'recv', email: 'r@x.com', password: 'password123' });
  // Make them friends: A requests, B accepts.
  const fs = friends as unknown as { friends: InMemoryFriends };
  const reqRow = await fs.friends.request(a.user.id, b.user.id);
  await fs.friends.respond(reqRow.id, b.user.id, true);
  await wallet.credit(a.user.id, 100_000, { type: 'deposit' }); // $1,000 to send

  return { app, repo, wallet, auth, senderId: a.user.id, senderToken: a.tokens.accessToken, recvId: b.user.id };
}

const doTransfer = (app: any, token: string, toUserId: string, amountCents: number) =>
  app.inject({ method: 'POST', url: '/api/wallet/transfer', headers: authH(token), payload: { toUserId, amountCents } });

test('compliance OFF: a transfer between friends succeeds (no behavior change)', async () => {
  const { app, senderToken, recvId } = await build({ complianceOn: false });
  const res = await doTransfer(app, senderToken, recvId, 5000);
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('compliance ON: a SELF-EXCLUDED sender is blocked (closes the self-exclusion bypass)', async () => {
  const { app, repo, senderToken, senderId, recvId } = await build({ complianceOn: true });
  await repo.updateCompliance(senderId, { selfExcludedUntil: Date.now() + 60_000 });
  const res = await doTransfer(app, senderToken, recvId, 5000);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'self_excluded');
  await app.close();
});

test('compliance ON: a SELF-EXCLUDED recipient is blocked (recipient_blocked)', async () => {
  const { app, repo, senderToken, recvId } = await build({ complianceOn: true });
  await repo.updateCompliance(recvId, { selfExcludedUntil: Date.now() + 60_000 });
  const res = await doTransfer(app, senderToken, recvId, 5000);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'recipient_blocked');
  await app.close();
});

test('daily cap (DAILY_TRANSFER_CAP_CENTS>0): blocks once 24h transfers-out would breach', async () => {
  const { app, wallet, senderToken, senderId, recvId } = await build({ dailyTransferCapCents: 10_000 }); // $100/day
  const ok = await doTransfer(app, senderToken, recvId, 6_000);
  assert.equal(ok.statusCode, 200);
  // $60 already sent; another $50 would exceed the $100 cap → 422.
  const over = await doTransfer(app, senderToken, recvId, 5_000);
  assert.equal(over.statusCode, 422);
  assert.equal(over.json().error.code, 'transfer_cap');
  // The exact remaining $40 is allowed.
  const exact = await doTransfer(app, senderToken, recvId, 4_000);
  assert.equal(exact.statusCode, 200);
  // Sanity: the ledger-derived sum matches what went out.
  assert.equal(await wallet.transferredOutSince(senderId, Date.now() - 24 * 60 * 60 * 1000), 10_000);
  await app.close();
});

test('cap 0 = UNLIMITED: large transfers are NOT capped (owner default)', async () => {
  const { app, senderToken, recvId } = await build({ dailyTransferCapCents: 0 });
  const a = await doTransfer(app, senderToken, recvId, 40_000);
  const b = await doTransfer(app, senderToken, recvId, 40_000);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200); // no cap applied
  await app.close();
});
