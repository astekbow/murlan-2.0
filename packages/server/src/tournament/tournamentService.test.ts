import test from 'node:test';
import assert from 'node:assert/strict';
import { TournamentService, InMemoryTournamentRepository, TournamentError, type TournamentWallet } from './tournamentService.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryUnitOfWork } from '../money/unitOfWork.ts';

/** Recording wallet: captures every money movement so we can assert escrow/payout/rake. */
class FakeWallet implements TournamentWallet {
  debits: Array<{ userId: string; cents: number }> = [];
  credits: Array<{ userId: string; cents: number }> = [];
  rake: number[] = [];
  insufficientFor = new Set<string>(); // userIds whose debit should fail
  async debit(userId: string, cents: number): Promise<void> {
    if (this.insufficientFor.has(userId)) throw new Error('insufficient');
    this.debits.push({ userId, cents });
  }
  async credit(userId: string, cents: number): Promise<void> { this.credits.push({ userId, cents }); }
  async recordRake(cents: number): Promise<void> { this.rake.push(cents); }
  async payoutChampion(winnerId: string, prizeCents: number, rakeCents: number): Promise<void> {
    if (prizeCents > 0) this.credits.push({ userId: winnerId, cents: prizeCents });
    if (rakeCents > 0) this.rake.push(rakeCents);
  }
}

function svc(rakeBps = 1000, dualControl = false) {
  const repo = new InMemoryTournamentRepository();
  const wallet = new FakeWallet();
  let n = 0;
  const s = new TournamentService(repo, wallet, rakeBps, () => 1_000, () => `trn_${(n += 1)}`, undefined, dualControl);
  return { s, wallet, repo };
}

test('create validates capacity (2/4/8 only)', async () => {
  const { s } = svc();
  await assert.rejects(s.create('x', 1000, 3), (e: unknown) => e instanceof TournamentError && e.code === 'bad_capacity');
  const t = await s.create('Cup', 1000, 4);
  assert.equal(t.status, 'registering');
  assert.equal(t.capacity, 4);
});

test('register escrows the buy-in and auto-starts when full', async () => {
  const { s, wallet } = svc();
  const t = await s.create('Cup', 1000, 4); // $10 buy-in, 4 players
  for (const u of ['a', 'b', 'c']) await s.register(t.id, u);
  let cur = (await s.get(t.id))!;
  assert.equal(cur.status, 'registering');           // not full yet
  assert.equal(wallet.debits.length, 3);             // 3 buy-ins escrowed
  assert.equal(cur.prizePoolCents, 3000);

  cur = await s.register(t.id, 'd');                  // 4th → fills + starts
  assert.equal(cur.status, 'running');
  assert.equal(cur.prizePoolCents, 4000);
  const r0 = cur.bracket.filter((m) => m.round === 0);
  assert.equal(r0.length, 2);                         // 4 players → 2 first-round matches
  assert.deepEqual([r0[0]!.aUserId, r0[0]!.bUserId], ['a', 'b']);
  assert.deepEqual([r0[1]!.aUserId, r0[1]!.bUserId], ['c', 'd']);
});

test('rejects double registration, a full bracket, and a failed (insufficient) buy-in', async () => {
  const { s, wallet } = svc();
  const t = await s.create('Cup', 1000, 2);
  await s.register(t.id, 'a');
  await assert.rejects(s.register(t.id, 'a'), (e: unknown) => e instanceof TournamentError && e.code === 'already_in');
  wallet.insufficientFor.add('poor');
  await assert.rejects(s.register(t.id, 'poor'), /insufficient/); // debit failed → NOT added
  assert.ok(!(await s.get(t.id))!.playerIds.includes('poor'));
});

test('full bracket advances and pays the champion pool − rake (4 players, $10, 10%)', async () => {
  const { s, wallet } = svc(1000); // 10% rake
  const t = await s.create('Cup', 1000, 4);
  for (const u of ['a', 'b', 'c', 'd']) await s.register(t.id, u);
  // Round 0: a beats b, c beats d → final a vs c.
  await s.reportResult(t.id, 0, 0, 'a');
  let cur = await s.reportResult(t.id, 0, 1, 'c');
  const finals = cur.bracket.filter((m) => m.round === 1);
  assert.equal(finals.length, 1);
  assert.deepEqual([finals[0]!.aUserId, finals[0]!.bUserId], ['a', 'c']);
  // Final: a wins → champion, payout.
  cur = await s.reportResult(t.id, 1, 0, 'a');
  assert.equal(cur.status, 'finished');
  assert.equal(cur.winnerId, 'a');
  // Pool $40, rake 10% = $4, prize $36.
  assert.deepEqual(wallet.rake, [400]);
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 3600 }]);
});

test('reportResult rejects a bad winner / decided match', async () => {
  const { s } = svc();
  const t = await s.create('Cup', 0, 2);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b'); // starts (free buy-in)
  await assert.rejects(s.reportResult(t.id, 0, 0, 'zzz'), (e: unknown) => e instanceof TournamentError && e.code === 'bad_winner');
  await s.reportResult(t.id, 0, 0, 'a'); // final (capacity 2) → finishes
  await assert.rejects(s.reportResult(t.id, 0, 0, 'b'), (e: unknown) => e instanceof TournamentError && (e.code === 'already_decided' || e.code === 'not_running'));
});

test('cancel refunds every escrowed buy-in', async () => {
  const { s, wallet } = svc();
  const t = await s.create('Cup', 1500, 4);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b');
  const cur = await s.cancel(t.id);
  assert.equal(cur.status, 'cancelled');
  assert.equal(cur.prizePoolCents, 0);
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 1500 }, { userId: 'b', cents: 1500 }]); // both refunded
});

test('cancel force-voids a RUNNING tournament and refunds all buy-ins (no champion paid)', async () => {
  const { s, wallet } = svc();
  const t = await s.create('Cup', 2000, 2);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b'); // fills → running
  assert.equal((await s.get(t.id))!.status, 'running');
  const cur = await s.cancel(t.id); // admin force-void of an abandoned bracket
  assert.equal(cur.status, 'cancelled');
  assert.equal(cur.prizePoolCents, 0);
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 2000 }, { userId: 'b', cents: 2000 }]);
  // A finished tournament can't be cancelled.
  const t2 = await s.create('Cup2', 0, 2);
  await s.register(t2.id, 'x');
  await s.register(t2.id, 'y');
  await s.reportResult(t2.id, 0, 0, 'x'); // finishes
  await assert.rejects(s.cancel(t2.id), (e: unknown) => e instanceof TournamentError && e.code === 'not_cancellable');
});

// ---- dual-control / four-eyes on the champion payout ----------------------
test('dual-control: a PAID final PARKS for a second admin; same-admin confirm rejected, a different admin pays out', async () => {
  const { s, wallet } = svc(1000, true);
  const t = await s.create('Cup', 1000, 2); // $10 buy-in
  await s.register(t.id, 'a');
  await s.register(t.id, 'b'); // fills → running
  // Report the final as admin_A → parks (no money moves yet).
  const parked = await s.reportResult(t.id, 0, 0, 'a', 'admin_A');
  assert.equal(parked.status, 'awaiting_confirmation');
  assert.equal(parked.pendingWinnerId, 'a');
  assert.deepEqual(wallet.credits, []);
  assert.deepEqual(wallet.rake, []);
  // The SAME admin cannot confirm their own report (four-eyes).
  await assert.rejects(s.confirmChampion(t.id, 'admin_A'), (e: unknown) => e instanceof TournamentError && e.code === 'same_admin');
  // A DIFFERENT admin confirms → champion paid (pool $20, 10% rake = $2, prize $18).
  const done = await s.confirmChampion(t.id, 'admin_B');
  assert.equal(done.status, 'finished');
  assert.equal(done.winnerId, 'a');
  assert.equal(done.pendingWinnerId, null);
  assert.deepEqual(wallet.rake, [200]);
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 1800 }]);
});

test('dual-control: a SELF-RUNNING final (autoFinalize) pays immediately, never parks', async () => {
  // The gateway reports self-running finals with autoFinalize=true — there is no admin
  // in the loop to confirm a four-eyes payout, so parking would strand the pool forever.
  const { s, wallet } = svc(1000, true); // dual-control ON
  const t = await s.create('Cup', 1000, 2); // $10 buy-in
  await s.register(t.id, 'a');
  await s.register(t.id, 'b'); // fills → running
  const done = await s.reportResult(t.id, 0, 0, 'a', undefined, { autoFinalize: true });
  assert.equal(done.status, 'finished'); // NOT 'awaiting_confirmation'
  assert.equal(done.winnerId, 'a');
  assert.equal(done.pendingWinnerId, null);
  assert.deepEqual(wallet.rake, [200]);                       // house took its 10%
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 1800 }]); // champion paid pool − rake
});

test('dual-control: a FREE final finishes immediately (no money → no second admin needed)', async () => {
  const { s, wallet } = svc(1000, true);
  const t = await s.create('Cup', 0, 2);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b');
  const done = await s.reportResult(t.id, 0, 0, 'a', 'admin_A');
  assert.equal(done.status, 'finished');
  assert.equal(done.winnerId, 'a');
  assert.deepEqual(wallet.credits, []); // free → prize 0
});

test('dual-control: confirmChampion on a non-parked tournament errors not_awaiting', async () => {
  const { s } = svc(1000, true);
  const t = await s.create('Cup', 1000, 2);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b'); // running, not awaiting
  await assert.rejects(s.confirmChampion(t.id, 'admin_B'), (e: unknown) => e instanceof TournamentError && e.code === 'not_awaiting');
});

test('dual-control: a parked tournament can be cancelled → all buy-ins refunded, no champion paid', async () => {
  const { s, wallet } = svc(1000, true);
  const t = await s.create('Cup', 1500, 2);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b');
  await s.reportResult(t.id, 0, 0, 'a', 'admin_A'); // parked
  const cancelled = await s.cancel(t.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.prizePoolCents, 0);
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 1500 }, { userId: 'b', cents: 1500 }]);
});

test('dual-control: sweepStale voids + refunds a parked-but-unconfirmed tournament past the TTL', async () => {
  const { s, wallet } = svc(1000, true);
  const t = await s.create('Cup', 1200, 2);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b');
  await s.reportResult(t.id, 0, 0, 'a', 'admin_A'); // awaiting_confirmation
  const voided = await s.sweepStale(0); // createdAt(1000) ≤ cutoff(1000) → swept
  assert.deepEqual(voided, [t.id]);
  assert.equal((await s.get(t.id))!.status, 'cancelled');
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 1200 }, { userId: 'b', cents: 1200 }]);
});

test('default (no dual-control): a PAID final still pays the champion immediately', async () => {
  const { s, wallet } = svc(1000); // dualControl off
  const t = await s.create('Cup', 1000, 2);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b');
  const done = await s.reportResult(t.id, 0, 0, 'a', 'admin_A'); // adminId ignored when off
  assert.equal(done.status, 'finished');
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 1800 }]);
});

test('SCH-3: with a UnitOfWork, register escrows + persists atomically and finish pays the champion via the tx-bound repo', async () => {
  // Real wallet + the SAME adapter shape app.ts wires, plus an InMemoryUnitOfWork whose
  // bound tournaments repo IS the service's repo — so escrow/payout AND the row write go
  // through one ctx. (In-memory has no real rollback, but this proves the ctx threading +
  // that the tx-bound repo is the one that actually persists — the prod Prisma tx then
  // gives the real all-or-nothing guarantee.)
  const users = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger);
  const repo = new InMemoryTournamentRepository();
  const uow = new InMemoryUnitOfWork(users, ledger, undefined, undefined, repo);
  const tw: TournamentWallet = {
    async debit(userId, cents, reason, ctx) { await (ctx ? wallet.bind(ctx) : wallet).debit(userId, cents, { type: 'bet', reason }); },
    async credit(userId, cents, reason) { await wallet.credit(userId, cents, { type: 'payout', reason, providerRef: reason }); },
    async recordRake(cents, ref) { await wallet.recordRake(cents, { providerRef: ref }); },
    async payoutChampion(winnerId, prizeCents, rakeCents, ref, ctx) {
      const pay = async (w: typeof wallet) => {
        if (prizeCents > 0) await w.credit(winnerId, prizeCents, { type: 'payout', reason: `tournament prize:${ref}`, providerRef: `tournament prize:${ref}` });
        if (rakeCents > 0) await w.recordRake(rakeCents, { providerRef: `tournament-rake:${ref}` });
      };
      if (ctx) await pay(wallet.bind(ctx));
      else await pay(wallet);
    },
  };
  let n = 0;
  const s = new TournamentService(repo, tw, 1000, () => 1000, () => `trn_${(n += 1)}`, uow);

  const a = await users.create({ username: 'a', email: 'a@x.com', passwordHash: 'h' });
  const b = await users.create({ username: 'b', email: 'b@x.com', passwordHash: 'h' });
  await wallet.credit(a.id, 5000, { type: 'deposit' });
  await wallet.credit(b.id, 5000, { type: 'deposit' });

  const t = await s.create('Cup', 1000, 2); // $10 buy-in, 2 players
  await s.register(t.id, a.id);
  assert.equal(await wallet.getBalance(a.id), 4000); // escrowed atomically (debit + row write)
  const running = await s.register(t.id, b.id);      // fills → running
  assert.equal(running.status, 'running');
  assert.equal(running.prizePoolCents, 2000);
  assert.equal(await wallet.getBalance(b.id), 4000);
  assert.equal((await s.get(t.id))!.playerIds.length, 2); // persisted via the tx-bound repo

  // Final (capacity 2 → one match): a wins → champion paid + status flipped in ONE tx.
  const done = await s.reportResult(t.id, 0, 0, a.id);
  assert.equal(done.status, 'finished');
  assert.equal(done.winnerId, a.id);
  // Pool $20, rake 10% = $2, prize $18 → a: 4000 + 1800 = 5800.
  assert.equal(await wallet.getBalance(a.id), 5800);
  assert.equal((await s.get(t.id))!.status, 'finished'); // finished status persisted with the payout
});

test('sweepStale voids + refunds abandoned tournaments past the TTL, leaves fresh ones alone', async () => {
  const { s, wallet } = svc(); // now() fixed at 1000, createdAt = 1000
  const t = await s.create('Cup', 1200, 4);
  await s.register(t.id, 'a');
  await s.register(t.id, 'b'); // registering (not full)
  // TTL larger than the tournament's age → nothing swept.
  assert.deepEqual(await s.sweepStale(1_000_000), []);
  assert.equal((await s.get(t.id))!.status, 'registering');
  // TTL of 0 → createdAt is at/under the cutoff → voided + refunded.
  const voided = await s.sweepStale(0);
  assert.deepEqual(voided, [t.id]);
  assert.equal((await s.get(t.id))!.status, 'cancelled');
  assert.deepEqual(wallet.credits, [{ userId: 'a', cents: 1200 }, { userId: 'b', cents: 1200 }]);
});

// ----- admin-4: manual /report reconciled against the recorded engine outcome ------
test('result reconciliation: a manual report CONTRADICTING the recorded engine winner is rejected', async () => {
  const { s } = svc(1000, false);
  const t = await s.create('Cup', 1000, 4);
  for (const u of ['a', 'b', 'c', 'd']) await s.register(t.id, u); // running, bracket seeded
  // The gateway records the engine-decided winner of pairing r0#0 as 'a'.
  s.recordRoomOutcome(t.id, 0, 0, 'a');
  // A manual admin report claiming the LOSER 'b' won that pairing is rejected.
  await assert.rejects(
    s.reportResult(t.id, 0, 0, 'b'),
    (e: unknown) => e instanceof TournamentError && e.code === 'result_conflict',
  );
  // The match is still undecided (nothing was written).
  const cur = (await s.get(t.id))!;
  assert.equal(cur.bracket.find((m) => m.round === 0 && m.index === 0)!.winnerId, null);
});

test('result reconciliation: a manual report AGREEING with the recorded engine winner proceeds', async () => {
  const { s } = svc(1000, false);
  const t = await s.create('Cup', 1000, 4);
  for (const u of ['a', 'b', 'c', 'd']) await s.register(t.id, u);
  s.recordRoomOutcome(t.id, 0, 0, 'a');
  const cur = await s.reportResult(t.id, 0, 0, 'a'); // matches the recorded outcome → ok
  assert.equal(cur.bracket.find((m) => m.round === 0 && m.index === 0)!.winnerId, 'a');
});

test('result reconciliation: with NO recorded outcome a manual report still works (stuck-pairing override)', async () => {
  const { s } = svc(1000, false);
  const t = await s.create('Cup', 1000, 4);
  for (const u of ['a', 'b', 'c', 'd']) await s.register(t.id, u);
  // No recordRoomOutcome → admin override of a genuinely stuck pairing is allowed.
  const cur = await s.reportResult(t.id, 0, 0, 'b');
  assert.equal(cur.bracket.find((m) => m.round === 0 && m.index === 0)!.winnerId, 'b');
});

test('result reconciliation: the trusted autoFinalize (engine) path is NOT blocked by a recorded outcome', async () => {
  const { s } = svc(1000, false);
  const t = await s.create('Cup', 1000, 2);
  for (const u of ['a', 'b']) await s.register(t.id, u); // capacity 2 → single final
  s.recordRoomOutcome(t.id, 0, 0, 'a');
  // The self-running path reports the same winner via autoFinalize; it is exempt from
  // reconciliation (it IS the source of truth) and finishes the tournament.
  const done = await s.reportResult(t.id, 0, 0, 'a', undefined, { autoFinalize: true });
  assert.equal(done.status, 'finished');
  assert.equal(done.winnerId, 'a');
});

test('adminDelete REFUSES an active tournament (would strand escrow) but deletes a cancelled one', async () => {
  const { s, repo } = svc();
  const t = await s.create('Cup', 1000, 4);
  await s.register(t.id, 'a'); // 'registering' — holds an escrowed buy-in
  await assert.rejects(s.adminDelete(t.id), (e: unknown) => e instanceof TournamentError && e.code === 'active');
  assert.ok(await repo.get(t.id), 'still present after the refused delete');
  await s.cancel(t.id); // refunds → 'cancelled'
  await s.adminDelete(t.id);
  assert.equal(await repo.get(t.id), null); // now deleted
  await s.adminDelete(t.id); // idempotent: deleting a missing tournament is a no-op
});
