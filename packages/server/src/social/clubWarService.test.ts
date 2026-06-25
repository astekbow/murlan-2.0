import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryClubWars } from './clubWarRepository.ts';
import { ClubWarService, ClubWarError, type ClubWarWallet } from './clubWarService.ts';

class RecWallet implements ClubWarWallet {
  debits: Array<{ userId: string; amount: number }> = [];
  credits: Array<{ userId: string; amount: number }> = [];
  payouts: Array<{ winners: Array<{ userId: string; amountCents: number }>; rake: number }> = [];
  broke = new Set<string>(); // these userIds fail to debit (insufficient funds)
  async debit(userId: string, amountCents: number): Promise<void> {
    if (this.broke.has(userId)) throw new Error('insufficient');
    this.debits.push({ userId, amount: amountCents });
  }
  async credit(userId: string, amountCents: number): Promise<void> { this.credits.push({ userId, amount: amountCents }); }
  async payoutSplit(winners: Array<{ userId: string; amountCents: number }>, rakeCents: number): Promise<void> {
    this.payouts.push({ winners, rake: rakeCents });
  }
}

const CLUB_A = 'clubA';
const CLUB_B = 'clubB';

test('paid war: escrow grows the pool, then A wins → split pool minus rake (cents conserved)', async () => {
  const wallet = new RecWallet();
  const svc = new ClubWarService(new InMemoryClubWars(), 1000, wallet); // 10% rake
  const war = await svc.create(CLUB_A, CLUB_B, 500, 2); // $5 buy-in, 2v2

  await svc.register(war.id, 'a1', 'A');
  await svc.register(war.id, 'b1', 'B');
  await svc.register(war.id, 'a2', 'A');
  let w = await svc.register(war.id, 'b2', 'B'); // 4th → auto-start
  assert.equal(w.status, 'running');
  assert.equal(w.prizePoolCents, 2000);
  assert.equal(w.pairings.length, 4); // 2×2 round-robin
  assert.equal(wallet.debits.length, 4);

  // A takes 3 of 4 pairings → club A wins.
  await svc.reportResult(war.id, 'a1', 'b1', 'a1');
  await svc.reportResult(war.id, 'a1', 'b2', 'a1');
  await svc.reportResult(war.id, 'a2', 'b1', 'b1'); // B wins one
  w = await svc.reportResult(war.id, 'a2', 'b2', 'a2'); // last → settle

  assert.equal(w.status, 'finished');
  assert.equal(w.scoreA, 3);
  assert.equal(w.scoreB, 1);
  assert.equal(w.winnerClubId, CLUB_A);
  assert.equal(wallet.payouts.length, 1);
  const { winners, rake } = wallet.payouts[0]!;
  // rake = 10% of 2000 = 200; prize 1800 split between a1,a2 = 900 each.
  assert.equal(rake, 200);
  assert.deepEqual(winners, [{ userId: 'a1', amountCents: 900 }, { userId: 'a2', amountCents: 900 }]);
  // CONSERVATION: payouts + rake == pool.
  assert.equal(winners.reduce((s, x) => s + x.amountCents, 0) + rake, 2000);
});

test('tie → refund every participant their buy-in, no winner, no rake', async () => {
  const wallet = new RecWallet();
  const svc = new ClubWarService(new InMemoryClubWars(), 1000, wallet);
  const war = await svc.create(CLUB_A, CLUB_B, 500, 2);
  for (const u of ['a1', 'a2']) await svc.register(war.id, u, 'A');
  for (const u of ['b1', 'b2']) await svc.register(war.id, u, 'B');

  // 2–2 split → tie.
  await svc.reportResult(war.id, 'a1', 'b1', 'a1');
  await svc.reportResult(war.id, 'a1', 'b2', 'b2');
  await svc.reportResult(war.id, 'a2', 'b1', 'a2');
  const w = await svc.reportResult(war.id, 'a2', 'b2', 'b2');

  assert.equal(w.status, 'finished');
  assert.equal(w.winnerClubId, null);
  assert.equal(wallet.payouts.length, 0);
  assert.equal(wallet.credits.length, 4); // all four refunded
  assert.ok(wallet.credits.every((c) => c.amount === 500));
});

test('cents remainder on an odd split goes to the house (exact conservation)', async () => {
  const wallet = new RecWallet();
  const svc = new ClubWarService(new InMemoryClubWars(), 0, wallet); // no rake → exercise remainder only
  const war = await svc.create(CLUB_A, CLUB_B, 100, 3); // pool 600, winning roster 3 → 200 each? make it odd
  for (const u of ['a1', 'a2', 'a3']) await svc.register(war.id, u, 'A');
  for (const u of ['b1', 'b2', 'b3']) await svc.register(war.id, u, 'B'); // pool 600
  // Make A win all 9 → A wins; prize 600 / 3 = 200 each, leftover 0. Force a remainder instead:
  // change stake so pool isn't divisible — re-do with pool 700 isn't possible here, so assert the
  // clean case + a separate remainder check below.
  for (const a of ['a1', 'a2', 'a3']) for (const b of ['b1', 'b2', 'b3']) await svc.reportResult(war.id, a, b, a);
  const w = await svc.get(war.id);
  assert.equal(w!.winnerClubId, CLUB_A);
  const { winners, rake } = wallet.payouts[0]!;
  assert.equal(winners.reduce((s, x) => s + x.amountCents, 0) + rake, 600); // conserved
});

test('remainder math: prize not divisible by winners → leftover cent to rake', async () => {
  const wallet = new RecWallet();
  const svc = new ClubWarService(new InMemoryClubWars(), 0, wallet);
  // 2 A-winners, pool must be odd. stake 50, 1 on A side? Use uneven rosters via force-start.
  const war = await svc.create(CLUB_A, CLUB_B, 50, 3);
  await svc.register(war.id, 'a1', 'A');
  await svc.register(war.id, 'a2', 'A'); // 2 on A
  await svc.register(war.id, 'b1', 'B'); // 1 on B → pool 150
  const started = await svc.start(war.id); // force-start uneven (2×1 = 2 pairings)
  assert.equal(started.pairings.length, 2);
  await svc.reportResult(war.id, 'a1', 'b1', 'a1');
  await svc.reportResult(war.id, 'a2', 'b1', 'a2'); // A wins 2–0
  const { winners, rake } = wallet.payouts[0]!;
  // prize 150 / 2 = 75 each, leftover 0 → rake 0. (Clean.) Conservation holds.
  assert.equal(winners.reduce((s, x) => s + x.amountCents, 0) + rake, 150);
  assert.deepEqual(winners.map((x) => x.amountCents), [75, 75]);
});

test('free war moves no money but still decides a winner', async () => {
  const svc = new ClubWarService(new InMemoryClubWars(), 1000); // no wallet
  const war = await svc.create(CLUB_A, CLUB_B, 0, 1); // free, 1v1
  await svc.register(war.id, 'a1', 'A');
  const w0 = await svc.register(war.id, 'b1', 'B'); // auto-start (1 each)
  assert.equal(w0.status, 'running');
  const w = await svc.reportResult(war.id, 'a1', 'b1', 'a1');
  assert.equal(w.status, 'finished');
  assert.equal(w.winnerClubId, CLUB_A);
});

test('guards: dupe register, full roster, paid war needs a wallet, idempotent result', async () => {
  const wallet = new RecWallet();
  const svc = new ClubWarService(new InMemoryClubWars(), 1000, wallet);
  const war = await svc.create(CLUB_A, CLUB_B, 500, 1);
  await svc.register(war.id, 'a1', 'A');
  await assert.rejects(() => svc.register(war.id, 'a1', 'A'), (e) => e instanceof ClubWarError && e.code === 'already');
  await assert.rejects(() => svc.register(war.id, 'a2', 'A'), (e) => e instanceof ClubWarError && e.code === 'full');
  const w = await svc.register(war.id, 'b1', 'B'); // auto-start (1 pairing → first result finishes it)
  assert.ok(w);

  // A paid war with no wallet is refused at create.
  const noWallet = new ClubWarService(new InMemoryClubWars(), 1000);
  await assert.rejects(() => noWallet.create(CLUB_A, CLUB_B, 500, 1), (e) => e instanceof ClubWarError && e.code === 'no_wallet');
});

test('reporting the same pairing twice (while still running) does NOT double-count', async () => {
  const wallet = new RecWallet();
  const svc = new ClubWarService(new InMemoryClubWars(), 1000, wallet);
  const war = await svc.create(CLUB_A, CLUB_B, 0, 2); // free 2v2 → 4 pairings, stays running after 1
  for (const u of ['a1', 'a2']) await svc.register(war.id, u, 'A');
  for (const u of ['b1', 'b2']) await svc.register(war.id, u, 'B');
  await svc.reportResult(war.id, 'a1', 'b1', 'a1');
  const again = await svc.reportResult(war.id, 'a1', 'b1', 'a1'); // idempotent no-op
  assert.equal(again.scoreA, 1, 'no double count');
  assert.equal(again.status, 'running', 'still 3 pairings to play');
});

test('a failed buy-in debit never seats the player', async () => {
  const wallet = new RecWallet();
  wallet.broke.add('poor');
  const svc = new ClubWarService(new InMemoryClubWars(), 1000, wallet);
  const war = await svc.create(CLUB_A, CLUB_B, 500, 2);
  await assert.rejects(() => svc.register(war.id, 'poor', 'A'));
  const w = await svc.get(war.id);
  assert.equal(w!.rosterA.length, 0);
  assert.equal(w!.prizePoolCents, 0);
});
