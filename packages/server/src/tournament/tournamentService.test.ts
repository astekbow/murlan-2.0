import test from 'node:test';
import assert from 'node:assert/strict';
import { TournamentService, InMemoryTournamentRepository, TournamentError, type TournamentWallet } from './tournamentService.ts';

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

function svc(rakeBps = 1000) {
  const repo = new InMemoryTournamentRepository();
  const wallet = new FakeWallet();
  let n = 0;
  const s = new TournamentService(repo, wallet, rakeBps, () => 1_000, () => `trn_${(n += 1)}`);
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
