import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryLedger } from './ledger.ts';
import { WalletService } from './walletService.ts';
import { InMemoryWithdrawals, WithdrawalService, WithdrawalError } from './withdrawals.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger);
  const u = await users.create({ username: 'w', email: 'w@x.com', passwordHash: 'h' });
  await wallet.credit(u.id, 5000, { type: 'deposit' });
  const svc = new WithdrawalService(wallet, new InMemoryWithdrawals(), { minCents: 500, maxCents: 1_000_000 });
  return { wallet, svc, userId: u.id };
}

test('request holds funds and enforces limits', async () => {
  const { wallet, svc, userId } = await setup();
  await assert.rejects(svc.request(userId, 100, 'addr'), (e: unknown) => e instanceof WithdrawalError && e.code === 'below_min');
  const rec = await svc.request(userId, 2000, 'addr-123');
  assert.equal(rec.status, 'pending');
  assert.equal(await wallet.getBalance(userId), 3000); // held
});

test('approve transitions once; a second approve is rejected as not_pending', async () => {
  const { svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, 'addr');
  const ok = await svc.approve(rec.id);
  assert.equal(ok.status, 'completed');
  await assert.rejects(svc.approve(rec.id), (e: unknown) => e instanceof WithdrawalError && e.code === 'not_pending');
});

test('reject refunds exactly once even under concurrent rejects (no double-credit)', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, 'addr');
  assert.equal(await wallet.getBalance(userId), 3000);

  // Fire two concurrent rejects for the same withdrawal.
  const [a, b] = await Promise.allSettled([svc.reject(rec.id), svc.reject(rec.id)]);
  // Both resolve to the rejected record (the refund is idempotent on providerRef).
  assert.ok(a.status === 'fulfilled' || b.status === 'fulfilled');

  // Refunded exactly once: 3000 (held) + 2000 (one refund) = 5000, NOT 7000.
  assert.equal(await wallet.getBalance(userId), 5000);
  const rec2 = await svc.reject(rec.id).catch((e) => e);
  assert.ok(rec2 instanceof WithdrawalError && rec2.code === 'not_pending'); // already resolved
  assert.equal(await wallet.getBalance(userId), 5000); // still 5000
});
