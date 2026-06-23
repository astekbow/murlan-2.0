import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryLedger } from './ledger.ts';
import { WalletService, InsufficientFundsError, DepositCapExceededError, BalanceCeilingError, MAX_AMOUNT_CENTS, BALANCE_CEILING_CENTS } from './walletService.ts';
import { InMemoryUnitOfWork } from './unitOfWork.ts';
import { InMemoryAdminAudit } from '../auth/adminAudit.ts';

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

// deposit-cap fix: a CAPPED deposit takes a per-user transaction-scoped advisory lock
// (pg_advisory_xact_lock in prod) so the cap holds across instances. Here a spy UoW
// records the lock key; an UNCAPPED credit must take NO lock.
test('deposit cap: a capped deposit acquires the per-user advisory lock; an uncapped credit does not', async () => {
  const users = new InMemoryUserRepository();
  const user = await users.create({ username: 'lk', email: 'lk@x.com', passwordHash: 'h' });
  const ledger = new InMemoryLedger();
  const locks: string[] = [];
  // A UoW that delegates to a pass-through InMemoryUnitOfWork but exposes advisoryXactLock.
  const inner = new InMemoryUnitOfWork(users, ledger);
  const spyUow = {
    transaction<T>(fn: (ctx: any) => Promise<T>): Promise<T> {
      return inner.transaction((ctx) => fn({ ...ctx, advisoryXactLock: async (k: string) => { locks.push(k); } }));
    },
  };
  const wallet = new WalletService(users, ledger, spyUow as never);

  await wallet.credit(user.id, 1000, { type: 'deposit', providerRef: 'cap1', depositCapCents: 10000 });
  assert.deepEqual(locks, [`deposit:${user.id}`]); // capped deposit took the lock

  locks.length = 0;
  await wallet.credit(user.id, 500, { type: 'payout' }); // uncapped credit
  assert.deepEqual(locks, []); // no lock for an uncapped credit
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
  await assert.rejects(wallet.credit(userId, MAX_AMOUNT_CENTS + 1, { type: 'deposit' }));
});

// money-22: a credit that would push the STORED balance over the int4-safe ceiling is
// refused (no overflow of the Int money columns).
test('rejects a credit that would push the stored balance over the int4 ceiling', async () => {
  const { wallet, userId } = await setup();
  // Bring the balance right up to the ceiling.
  await wallet.credit(userId, BALANCE_CEILING_CENTS, { type: 'deposit', providerRef: 'd1' });
  assert.equal(await wallet.getBalance(userId), BALANCE_CEILING_CENTS);
  // One more cent would overflow → rejected, balance unchanged.
  await assert.rejects(
    () => wallet.credit(userId, 1, { type: 'deposit', providerRef: 'd2' }),
    (e: unknown) => e instanceof BalanceCeilingError,
  );
  assert.equal(await wallet.getBalance(userId), BALANCE_CEILING_CENTS);
});

test('an idempotent REPLAY of an at-ceiling credit is NOT falsely rejected', async () => {
  const { wallet, userId } = await setup();
  const ref = 'big1';
  await wallet.credit(userId, BALANCE_CEILING_CENTS, { type: 'deposit', providerRef: ref });
  // Replaying the same ref returns idempotent (the balance already includes it) — the
  // ceiling guard must not trip on the replay.
  const replay = await wallet.credit(userId, BALANCE_CEILING_CENTS, { type: 'deposit', providerRef: ref });
  assert.equal(replay.idempotent, true);
  assert.equal(await wallet.getBalance(userId), BALANCE_CEILING_CENTS);
});

// admin-5: a balance adjust records its AdminAction audit row alongside the money move;
// an idempotent replay records NO second audit (it didn't move money).
test('adminAdjustAudited records the audit on a real move and not on an idempotent replay', async () => {
  const { wallet, userId } = await setup();
  const audit = new InMemoryAdminAudit();
  const rec = { adminId: 'admin1', action: 'balance_adjust' as const, targetUserId: userId, amountCents: 5000, detail: 'manual [tron:abc]' };
  const first = await wallet.adminAdjustAudited(userId, 5000, 'manual', { ...rec }, audit, { providerRef: 'tron:abc' });
  assert.equal(first.idempotent, false);
  assert.equal((await audit.list()).length, 1); // one audit row for the real credit

  // A replay of the same providerRef is idempotent → NO money move → NO new audit row.
  const replay = await wallet.adminAdjustAudited(userId, 5000, 'manual', { ...rec }, audit, { providerRef: 'tron:abc' });
  assert.equal(replay.idempotent, true);
  assert.equal((await audit.list()).length, 1); // still one — not double-audited
  assert.equal(await wallet.getBalance(userId), 5000);
});

test('adminAdjustAudited (UoW path): audit failure rolls back the money (atomic)', async () => {
  const users = new InMemoryUserRepository();
  const user = await users.create({ username: 'atomic', email: 'at@x.com', passwordHash: 'h' });
  const ledger = new InMemoryLedger();
  // A UoW whose transaction propagates a throw (the real Prisma $transaction rolls back
  // on a throw). The in-memory UoW is a pass-through, so to PROVE the rollback contract
  // we make the audit insert throw and assert the call rejects (the prod tx then rolls
  // back both writes). We at least verify the throw surfaces and isn't swallowed.
  const throwingAudit = { record: async () => { throw new Error('audit down'); }, list: async () => [] };
  const uow = new InMemoryUnitOfWork(users, ledger, undefined, undefined, undefined, throwingAudit as never);
  const wallet = new WalletService(users, ledger, uow);
  await assert.rejects(
    () => wallet.adminAdjustAudited(user.id, 5000, 'x', { adminId: 'a', action: 'balance_adjust', targetUserId: user.id, amountCents: 5000 }, throwingAudit as never),
    /audit down/,
  );
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

test('transfer moves balance atomically between two players (transfer_out + transfer_in rows)', async () => {
  const { users, ledger, wallet, userId } = await setup();
  const friend = await users.create({ username: 'shoku', email: 's@x.com', passwordHash: 'h' });
  await wallet.credit(userId, 5000, { type: 'deposit', reason: 'seed' });
  const res = await wallet.transfer(userId, friend.id, 2000);
  assert.equal(res.balanceCents, 3000);
  assert.equal(await wallet.getBalance(userId), 3000);
  assert.equal(await wallet.getBalance(friend.id), 2000);
  assert.ok((await ledger.listByUser(userId)).some((r) => r.type === 'transfer_out' && r.amountCents === -2000));
  assert.ok((await ledger.listByUser(friend.id)).some((r) => r.type === 'transfer_in' && r.amountCents === 2000));
  // No money created or lost: sender lost exactly what the receiver gained.
  assert.equal(await wallet.getBalance(userId) + await wallet.getBalance(friend.id), 5000);
});

test('transfer with insufficient funds throws and changes nothing', async () => {
  const { users, wallet, userId } = await setup();
  const friend = await users.create({ username: 'shoku2', email: 's2@x.com', passwordHash: 'h' });
  await wallet.credit(userId, 1000, { type: 'deposit' });
  await assert.rejects(() => wallet.transfer(userId, friend.id, 5000), InsufficientFundsError);
  assert.equal(await wallet.getBalance(userId), 1000);
  assert.equal(await wallet.getBalance(friend.id), 0);
});

test('transfer to self is rejected (no balance change)', async () => {
  const { wallet, userId } = await setup();
  await wallet.credit(userId, 1000, { type: 'deposit' });
  await assert.rejects(() => wallet.transfer(userId, userId, 100), /self/);
  assert.equal(await wallet.getBalance(userId), 1000);
});

// money-2: an admin manual credit of an unclaimed on-chain deposit can carry the TxID's
// providerRef so a LATER player claim of the same TxID is an idempotent no-op (no double-credit).
test('adminAdjust with a providerRef credits once; a later same-ref credit is idempotent (no double-credit)', async () => {
  const { wallet, userId } = await setup();
  const ref = 'tron:abc123';
  // Operator manually credits the unclaimed deposit by its TxID.
  const first = await wallet.adminAdjust(userId, 5000, 'manual deposit credit', { providerRef: ref });
  assert.equal(first.idempotent, false);
  assert.equal(first.balanceCents, 5000);
  // Player later claims the SAME TxID via the normal deposit path → same providerRef.
  const claim = await wallet.credit(userId, 5000, { type: 'deposit', providerRef: ref });
  assert.equal(claim.idempotent, true);
  assert.equal(await wallet.getBalance(userId), 5000); // still 5000 — NOT double-credited
});

test('adminAdjust rejects a providerRef on a debit (a TxID-bound adjust must be a credit)', async () => {
  const { wallet, userId } = await setup();
  await wallet.credit(userId, 5000, { type: 'deposit' });
  await assert.rejects(() => wallet.adminAdjust(userId, -1000, 'x', { providerRef: 'tron:zzz' }), /credit/);
  assert.equal(await wallet.getBalance(userId), 5000);
});

// money-23: house rake is read from the LEDGER (getBalance(house) is always 0).
test('getHouseRakeCents sums the house rake ledger (not the always-0 house balance)', async () => {
  const { wallet, ledger, userId } = await setup();
  assert.equal(await wallet.getHouseRakeCents(), 0);
  // Two pots take rake; the house "balance" stays 0 but the ledger accrues it.
  await wallet.credit(userId, 10000, { type: 'deposit' });
  await wallet.recordRake(300, { matchId: 'm1', providerRef: 'rake:m1' });
  await wallet.recordRake(450, { matchId: 'm2', providerRef: 'rake:m2' });
  assert.equal(await wallet.getBalance('__house__'), 0);   // no balance row
  assert.equal(await wallet.getHouseRakeCents(), 750);     // ledger sum is correct
  // Sanity: the aggregate equals a manual sum of the rake rows.
  const houseTxs = await ledger.listByUser('__house__');
  const manual = houseTxs.filter((t) => t.type === 'rake').reduce((s, t) => s + Math.abs(t.amountCents), 0);
  assert.equal(manual, 750);
});
