import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryLedger } from './ledger.ts';
import { WalletService } from './walletService.ts';
import { InMemoryUnitOfWork } from './unitOfWork.ts';
import { InMemoryWithdrawals, WithdrawalService, WithdrawalError } from './withdrawals.ts';
import type { PayoutProvider } from './payoutProvider.ts';

const okPayout = (providerRef = 'binance_W1'): PayoutProvider => ({ name: 'binance-payout', payout: async () => ({ ok: true, providerRef }) });
const failPayout = (error = 'insufficient binance balance'): PayoutProvider => ({ name: 'binance-payout', payout: async () => ({ ok: false, error }) });

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

test('audit fields default null, and approve/reject stamp them (resolvedByAdminId, providerRef, failureReason)', async () => {
  const { svc, userId } = await setup();
  const a = await svc.request(userId, 2000, 'addr');
  assert.equal(a.resolvedByAdminId, null);
  assert.equal(a.providerRef, null);
  const approved = await svc.approve(a.id, { resolvedByAdminId: 'admin_1', providerRef: 'binance_W1' });
  assert.equal(approved.resolvedByAdminId, 'admin_1');
  assert.equal(approved.providerRef, 'binance_W1');

  const b = await svc.request(userId, 1000, 'addr2');
  const rejected = await svc.reject(b.id, { resolvedByAdminId: 'admin_2', failureReason: 'suspicious' });
  assert.equal(rejected.resolvedByAdminId, 'admin_2');
  assert.equal(rejected.failureReason, 'suspicious');
});

test('atomic request via UnitOfWork: debit + record commit together; insufficient funds maps to a WithdrawalError', async () => {
  const users = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger);
  const repo = new InMemoryWithdrawals();
  // Share the SAME repo with the UoW so the atomic-path create lands where find() reads.
  const uow = new InMemoryUnitOfWork(users, ledger, undefined, repo);
  const u = await users.create({ username: 'a', email: 'a@x.com', passwordHash: 'h' });
  await wallet.credit(u.id, 3000, { type: 'deposit' });
  const svc = new WithdrawalService(wallet, repo, { minCents: 500, maxCents: 1_000_000 }, uow);

  const rec = await svc.request(u.id, 2000, 'addr-xyz');
  assert.equal(rec.status, 'pending');
  assert.equal(await wallet.getBalance(u.id), 1000); // held atomically
  assert.equal((await svc.find(rec.id))?.id, rec.id); // record persisted

  await assert.rejects(svc.request(u.id, 5000, 'addr-xyz'), (e: unknown) => e instanceof WithdrawalError && e.code === 'insufficient_funds');
  assert.equal(await wallet.getBalance(u.id), 1000); // unchanged — nothing held on failure
});

test('payoutNow SENDS via the provider, marks completed, and stamps the providerRef', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6');
  assert.equal(await wallet.getBalance(userId), 3000); // held
  let seen: { withdrawalId: string; amountCents: number; address: string } | null = null;
  const provider: PayoutProvider = { name: 'binance-payout', payout: async (r) => { seen = r; return { ok: true, providerRef: 'binance_W9' }; } };
  const w = await svc.payoutNow(rec.id, provider, { resolvedByAdminId: 'admin_1' });
  assert.equal(w.status, 'completed');
  assert.equal(w.providerRef, 'binance_W9');
  assert.equal(w.resolvedByAdminId, 'admin_1');
  assert.deepEqual(seen, { withdrawalId: rec.id, amountCents: 2000, address: 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6' });
  assert.equal(await wallet.getBalance(userId), 3000); // paid out — NOT refunded
  assert.equal((await svc.find(rec.id))?.providerRef, 'binance_W9'); // persisted
});

test('payoutNow REFUNDS and does NOT complete when the send fails', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6');
  assert.equal(await wallet.getBalance(userId), 3000); // held
  await assert.rejects(
    svc.payoutNow(rec.id, failPayout(), { resolvedByAdminId: 'admin_1' }),
    (e: unknown) => e instanceof WithdrawalError && e.code === 'payout_failed',
  );
  assert.equal(await wallet.getBalance(userId), 5000); // refunded exactly once
  assert.equal((await svc.find(rec.id))?.status, 'rejected'); // reversed out of completed
});

test('payoutNow with NO real provider just marks completed (operator paid manually)', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6');
  const w = await svc.payoutNow(rec.id, null, { resolvedByAdminId: 'admin_1' });
  assert.equal(w.status, 'completed');
  assert.equal(await wallet.getBalance(userId), 3000); // funds stay debited (sent by hand)
});

test('a reject AFTER a successful payoutNow cannot refund the sent payout (no double-pay)', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6');
  await svc.payoutNow(rec.id, okPayout(), { resolvedByAdminId: 'admin_1' });
  assert.equal(await wallet.getBalance(userId), 3000); // paid
  await assert.rejects(svc.reject(rec.id), (e: unknown) => e instanceof WithdrawalError && e.code === 'not_pending');
  assert.equal(await wallet.getBalance(userId), 3000); // still paid — NOT refunded
});
