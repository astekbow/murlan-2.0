import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryLedger } from './ledger.ts';
import { WalletService, InsufficientFundsError, DepositCapExceededError } from './walletService.ts';
import { InMemoryUnitOfWork } from './unitOfWork.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const user = await users.create({ username: 'lojtar', email: 'l@x.com', passwordHash: 'h' });
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger);
  return { users, ledger, wallet, userId: user.id };
}

test('credit increases the balance and writes a ledger row', async () => {
  const { wallet, userId } = await setup();
  const res = await wallet.credit(userId, 5000, { type: 'deposit', reason: 'test' });
  assert.equal(res.balanceCents, 5000);
  assert.equal(res.idempotent, false);
  assert.equal(res.transaction.amountCents, 5000);
  assert.equal(await wallet.getBalance(userId), 5000);
});

test('credit is idempotent on providerRef (a retried webhook never double-credits)', async () => {
  const { wallet, userId } = await setup();
  const first = await wallet.credit(userId, 5000, { type: 'deposit', providerRef: 'pay_123' });
  assert.equal(first.idempotent, false);
  const retry = await wallet.credit(userId, 5000, { type: 'deposit', providerRef: 'pay_123' });
  assert.equal(retry.idempotent, true);
  assert.equal(await wallet.getBalance(userId), 5000); // still 5000, not 10000
  assert.equal(retry.transaction.id, first.transaction.id);
});

test('deposit cap: a credit within the cap succeeds; one over the cap is rejected with NO ledger row', async () => {
  const { wallet, ledger, userId } = await setup();
  const ok = await wallet.credit(userId, 6000, { type: 'deposit', providerRef: 'd1', depositCapCents: 10000 });
  assert.equal(ok.balanceCents, 6000);
  await assert.rejects(
    () => wallet.credit(userId, 5000, { type: 'deposit', providerRef: 'd2', depositCapCents: 10000 }),
    DepositCapExceededError,
  );
  assert.equal(await wallet.getBalance(userId), 6000); // unchanged
  assert.equal((await ledger.listByUser(userId)).length, 1); // the rejected deposit left no row
});

test('deposit cap: a retried webhook (same providerRef) stays idempotent, never double-counted into the cap', async () => {
  const { wallet, userId } = await setup();
  await wallet.credit(userId, 8000, { type: 'deposit', providerRef: 'd1', depositCapCents: 10000 });
  const retry = await wallet.credit(userId, 8000, { type: 'deposit', providerRef: 'd1', depositCapCents: 10000 });
  assert.equal(retry.idempotent, true); // not rejected as 8000+8000 over cap
  assert.equal(await wallet.getBalance(userId), 8000);
});

test('deposit cap: concurrent same-user deposits cannot BOTH pass the cap (race closed)', async () => {
  const { wallet, userId } = await setup();
  const results = await Promise.allSettled([
    wallet.credit(userId, 6000, { type: 'deposit', providerRef: 'c1', depositCapCents: 10000 }),
    wallet.credit(userId, 6000, { type: 'deposit', providerRef: 'c2', depositCapCents: 10000 }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]!.reason instanceof DepositCapExceededError);
  assert.equal(await wallet.getBalance(userId), 6000); // only one 6000 landed
});

test('debit decreases the balance and refuses to overdraw', async () => {
  const { wallet, userId } = await setup();
  await wallet.credit(userId, 3000, { type: 'deposit' });
  const res = await wallet.debit(userId, 1000, { type: 'bet', matchId: 'm1' });
  assert.equal(res.balanceCents, 2000);
  assert.equal(res.transaction.amountCents, -1000);

  await assert.rejects(
    wallet.debit(userId, 999999, { type: 'bet' }),
    (e: unknown) => e instanceof InsufficientFundsError,
  );
  assert.equal(await wallet.getBalance(userId), 2000); // unchanged after failed debit
});

test('rejects non-positive / non-integer amounts', async () => {
  const { wallet, userId } = await setup();
  await assert.rejects(wallet.credit(userId, 0, { type: 'deposit' }));
  await assert.rejects(wallet.credit(userId, -5, { type: 'deposit' }));
  await assert.rejects(wallet.credit(userId, 10.5, { type: 'deposit' }));
});

test('adminAdjust credits on positive delta and debits on negative', async () => {
  const { wallet, userId } = await setup();
  await wallet.adminAdjust(userId, 2000, 'bonus');
  assert.equal(await wallet.getBalance(userId), 2000);
  await wallet.adminAdjust(userId, -500, 'correction');
  assert.equal(await wallet.getBalance(userId), 1500);
  const txs = await wallet.listTransactions(userId);
  assert.equal(txs.length, 2);
  assert.ok(txs.every((t) => t.type === 'admin_adjust'));
});

test('concurrent identical webhook credits never double-credit (idempotency is atomic)', async () => {
  const { wallet, userId } = await setup();
  // Fire two same-providerRef credits concurrently; exactly one should apply.
  const [a, b] = await Promise.all([
    wallet.credit(userId, 5000, { type: 'deposit', providerRef: 'pay_concurrent' }),
    wallet.credit(userId, 5000, { type: 'deposit', providerRef: 'pay_concurrent' }),
  ]);
  assert.equal(await wallet.getBalance(userId), 5000); // not 10000
  assert.notEqual(a.idempotent, b.idempotent); // exactly one was the idempotent replay
});

test('rejects an amount above the safe maximum', async () => {
  const { wallet, userId } = await setup();
  await assert.rejects(wallet.credit(userId, 100_000_000_00 + 1, { type: 'deposit' }));
});

test('credit/debit run through a UnitOfWork (transactional path) with identical results', async () => {
  const users = new InMemoryUserRepository();
  const user = await users.create({ username: 'tx', email: 't@x.com', passwordHash: 'h' });
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger, new InMemoryUnitOfWork(users, ledger));

  const c = await wallet.credit(user.id, 5000, { type: 'deposit', providerRef: 'pp_uow' });
  assert.equal(c.balanceCents, 5000);
  // idempotent replay still works through the UoW
  assert.equal((await wallet.credit(user.id, 5000, { type: 'deposit', providerRef: 'pp_uow' })).idempotent, true);
  const d = await wallet.debit(user.id, 2000, { type: 'bet', matchId: 'm' });
  assert.equal(d.balanceCents, 3000);
  await assert.rejects(wallet.debit(user.id, 999999, { type: 'bet' }), (e: unknown) => e instanceof InsufficientFundsError);
  assert.equal((await wallet.reconcile()).ok, true);
});

test('reconcile passes after a sequence of moves and rake stays ledger-only', async () => {
  const { wallet, userId } = await setup();
  await wallet.credit(userId, 5000, { type: 'deposit' });
  await wallet.debit(userId, 1000, { type: 'bet', matchId: 'm1' });
  await wallet.credit(userId, 1800, { type: 'payout', matchId: 'm1' });
  await wallet.recordRake(200, { matchId: 'm1' }); // house account, no user balance

  const rec = await wallet.reconcile();
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
  assert.equal(await wallet.getBalance(userId), 5800);
});
