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

test('sumUserSince is UNBOUNDED — the per-user daily cap is not capped at 100 rows (audit money, 2026-07-03)', async () => {
  // The bug: the daily auto-payout cap read withdrawals.listByUser (bounded to 100 rows), so
  // past 100 in-window withdrawals the prior-total froze and small withdrawals bypassed the cap.
  // sumUserSince must sum ALL non-rejected rows in the window, well beyond 100.
  const users = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger);
  const u = await users.create({ username: 'many', email: 'm@x.com', passwordHash: 'h' });
  await wallet.credit(u.id, 10_000_000, { type: 'deposit' });
  const repo = new InMemoryWithdrawals();
  const svc = new WithdrawalService(wallet, repo, { minCents: 500, maxCents: 1_000_000 });
  for (let i = 0; i < 150; i++) await svc.request(u.id, 1000, `addr-${i}`); // 150 × $10 = $1,500

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const sum = await svc.sumUserSince(u.id, dayAgo);
  assert.equal(sum, 150 * 1000, 'sums all 150 rows, not the newest 100');
  // The display list is STILL bounded (dos-2) — proving the two paths are distinct.
  assert.equal((await svc.listByUser(u.id)).length, 100, 'listByUser stays capped at 100');

  // A rejected row must NOT count toward the cap.
  const rec = await svc.request(u.id, 1000, 'addr-rej');
  await svc.reject(rec.id);
  assert.equal(await svc.sumUserSince(u.id, dayAgo), 150 * 1000, 'rejected withdrawals excluded');
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

// ===== money-16 / money-13 / money-17: auto-pay double-pay protection ========

const dupPayout = (): PayoutProvider => ({ name: 'binance-payout', payout: async () => ({ ok: false, duplicate: true, providerRef: 'orig_W', error: 'duplicate withdrawOrderId' }) });
const ambiguousPayout = (): PayoutProvider => ({ name: 'binance-payout', payout: async () => ({ ok: false, ambiguous: true, error: 'timeout' }) });

const VALID_ADDR = 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6';

test('autoPayout CLAIMS the row (pending→completed) BEFORE sending', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  let statusAtSend: string | null = null;
  const provider: PayoutProvider = {
    name: 'binance-payout',
    payout: async () => { statusAtSend = (await svc.find(rec.id))!.status; return { ok: true, providerRef: 'W1' }; },
  };
  const r = await svc.autoPayout(rec.id, provider);
  assert.equal(r.outcome, 'paid');
  assert.equal(statusAtSend, 'completed'); // claimed BEFORE the provider was called
  assert.equal(await wallet.getBalance(userId), 3000); // paid out, not refunded
});

test('autoPayout: a concurrent REJECT during the send window does NOT double-pay', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  assert.equal(await wallet.getBalance(userId), 3000); // held
  // Provider send is in flight when a reject races in. The reject must lose (row already
  // claimed 'completed') → no refund; the player is paid exactly once.
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((res) => { releaseSend = res; });
  const provider: PayoutProvider = { name: 'binance-payout', payout: async () => { await sendGate; return { ok: true, providerRef: 'W1' }; } };
  const sending = svc.autoPayout(rec.id, provider);
  // Fire the reject WHILE the send is pending (row is already claimed completed).
  const rejected = await svc.reject(rec.id).catch((e) => e);
  assert.ok(rejected instanceof WithdrawalError && rejected.code === 'not_pending'); // reject lost the race
  releaseSend();
  const r = await sending;
  assert.equal(r.outcome, 'paid');
  assert.equal(await wallet.getBalance(userId), 3000); // paid once, NOT refunded (would be 5000 on a double)
  assert.equal((await svc.find(rec.id))!.status, 'completed');
});

test('autoPayout: a DUPLICATE-rejection marks completed and does NOT refund', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  const r = await svc.autoPayout(rec.id, dupPayout());
  assert.equal(r.outcome, 'duplicate');
  assert.equal((await svc.find(rec.id))!.status, 'completed'); // stays paid (original send stood)
  assert.equal(await wallet.getBalance(userId), 3000); // NOT refunded (no double-credit)
});

test('autoPayout: an AMBIGUOUS failure does NOT refund and leaves the row completed', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  const r = await svc.autoPayout(rec.id, ambiguousPayout());
  assert.equal(r.outcome, 'ambiguous');
  assert.equal((await svc.find(rec.id))!.status, 'completed'); // maybe-sent → left paid, flagged
  assert.equal(await wallet.getBalance(userId), 3000); // NEVER refunded on a maybe-sent payout
});

test('autoPayout: a DEFINITE failure refunds exactly once (idempotent) and reverses the row', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  assert.equal(await wallet.getBalance(userId), 3000); // held
  const r = await svc.autoPayout(rec.id, failPayout('binance 400 bad address'));
  assert.equal(r.outcome, 'failed');
  assert.equal(await wallet.getBalance(userId), 5000); // refunded once
  assert.equal((await svc.find(rec.id))!.status, 'rejected'); // reversed out of completed
  // A reconciler re-run / second refund attempt is idempotent on providerRef — still 5000.
  await wallet.credit(userId, 2000, { type: 'admin_adjust', reason: 'rikthim: auto-pagesa dështoi', providerRef: `withdrawal_refund:${rec.id}` });
  assert.equal(await wallet.getBalance(userId), 5000);
});

test('payoutNow on a DUPLICATE → marks completed, NO refund (panel approve of a maybe-already-sent)', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  const w = await svc.payoutNow(rec.id, dupPayout(), { resolvedByAdminId: 'admin_1' });
  assert.equal(w.status, 'completed');
  assert.equal(await wallet.getBalance(userId), 3000); // NOT refunded
});

test('payoutNow on an AMBIGUOUS result → throws payout_ambiguous, NEVER refunds, row stays completed', async () => {
  const { wallet, svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  await assert.rejects(
    svc.payoutNow(rec.id, ambiguousPayout(), { resolvedByAdminId: 'admin_1' }),
    (e: unknown) => e instanceof WithdrawalError && e.code === 'payout_ambiguous',
  );
  assert.equal(await wallet.getBalance(userId), 3000); // NOT refunded
  assert.equal((await svc.find(rec.id))!.status, 'completed'); // left paid (maybe sent)
});

test('autoPayout refuses a row that is already not-pending (no send, no refund)', async () => {
  const { svc, userId } = await setup();
  const rec = await svc.request(userId, 2000, VALID_ADDR);
  await svc.approve(rec.id); // resolve it first
  let sent = false;
  const provider: PayoutProvider = { name: 'binance-payout', payout: async () => { sent = true; return { ok: true }; } };
  const r = await svc.autoPayout(rec.id, provider);
  assert.equal(r.outcome, 'not_pending');
  assert.equal(sent, false); // never sent
});

test('money-7: autoPaidSince counts ONLY auto-resolved completed rows (global + per-dest)', async () => {
  const { svc, userId } = await setup();
  // An AUTO-paid row (resolvedByAdminId stays null via autoPayout).
  const a = await svc.request(userId, 1000, VALID_ADDR);
  await svc.autoPayout(a.id, okPayout());
  // A MANUALLY-approved row (resolvedByAdminId set) — must NOT count toward the auto cap.
  const b = await svc.request(userId, 2000, VALID_ADDR);
  await svc.payoutNow(b.id, okPayout(), { resolvedByAdminId: 'admin_1' });
  const since = Date.now() - 24 * 60 * 60 * 1000;
  assert.equal(await svc.autoPaidSince(since), 1000); // only the auto row
  assert.equal(await svc.autoPaidSince(since, VALID_ADDR), 1000); // same address
  assert.equal(await svc.autoPaidSince(since, 'TOtherAddress00000000000000000000'), 0); // other dest
});
