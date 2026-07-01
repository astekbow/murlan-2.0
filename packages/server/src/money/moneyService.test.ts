import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryLedger, type LedgerRepository, type NewTransaction, type Transaction } from './ledger.ts';
import { WalletService, HOUSE_ACCOUNT_ID } from './walletService.ts';
import { InMemoryMatchesRepository, type MatchesRepository } from './matchesRepository.ts';
import { MoneyService, forfeitWinners } from './moneyService.ts';

// Simulates the Postgres FK `transactions.matchId -> matches.id`: an append that
// references a match row which does not exist yet throws (as P2003 would). The
// plain InMemoryLedger has no such constraint, which is exactly why it hid the
// escrow-ordering bug (debiting stakes before the match row existed).
class FkLedger implements LedgerRepository {
  constructor(private readonly inner: InMemoryLedger, private readonly matches: MatchesRepository) {}
  private async assertFk(tx: NewTransaction): Promise<void> {
    if (tx.matchId != null && !(await this.matches.find(tx.matchId))) {
      throw new Error(`FK violation: matches.id "${tx.matchId}" does not exist`);
    }
  }
  async append(tx: NewTransaction): Promise<Transaction> { await this.assertFk(tx); return this.inner.append(tx); }
  async appendIdempotent(tx: NewTransaction & { providerRef: string }) { await this.assertFk(tx); return this.inner.appendIdempotent(tx); }
  findByProviderRef(ref: string) { return this.inner.findByProviderRef(ref); }
  listByUser(id: string) { return this.inner.listByUser(id); }
  all() { return this.inner.all(); }
}

async function setup(balances: number[]) {
  const users = new InMemoryUserRepository();
  const ids: string[] = [];
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(users, ledger);
  for (let i = 0; i < balances.length; i++) {
    const u = await users.create({ username: `p${i}`, email: `p${i}@x.com`, passwordHash: 'h' });
    ids.push(u.id);
    if (balances[i]! > 0) await wallet.credit(u.id, balances[i]!, { type: 'deposit' });
  }
  const money = new MoneyService(wallet, new InMemoryMatchesRepository());
  return { wallet, money, ids, ledger };
}

const players = (ids: string[]) => ids.map((userId, seat) => ({ seat, userId }));

test('escrow debits every stake into the pot', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  const res = await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  assert.equal(res.ok, true);
  assert.equal(res.potCents, 2000);
  assert.equal(await wallet.getBalance(ids[0]!), 0);
  assert.equal(await wallet.getBalance(ids[1]!), 0);
});

test('escrow refuses (and moves no money) when a player cannot afford the stake', async () => {
  const { wallet, money, ids } = await setup([1000, 300]);
  const res = await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'insufficient_funds');
  assert.deepEqual(res.insufficientUserIds, [ids[1]!]);
  assert.equal(await wallet.getBalance(ids[0]!), 1000); // untouched
  assert.equal(await wallet.getBalance(ids[1]!), 300);
});

test('escrow creates the match row BEFORE debiting (honors the transactions.matchId FK)', async () => {
  // Regression: staked matches silently failed to start on Postgres because the
  // stake ledger rows were written before the match row existed (FK P2003).
  const users = new InMemoryUserRepository();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const u = await users.create({ username: `q${i}`, email: `q${i}@x.com`, passwordHash: 'h' });
    ids.push(u.id);
  }
  const matches = new InMemoryMatchesRepository();
  const wallet = new WalletService(users, new FkLedger(new InMemoryLedger(), matches));
  await wallet.credit(ids[0]!, 1000, { type: 'deposit' }); // no matchId → FK ok
  await wallet.credit(ids[1]!, 1000, { type: 'deposit' });
  const money = new MoneyService(wallet, matches);

  // Under the old debit-first order this threw the FK error; now it succeeds.
  const res = await money.escrow({ matchId: 'mfk', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  assert.equal(res.ok, true);
  assert.equal(res.potCents, 2000);
  assert.equal(await wallet.getBalance(ids[0]!), 0);
  assert.ok(await matches.find('mfk'), 'match row must exist after escrow');
});

test('escrow is idempotent (re-escrow returns the pot without re-debiting)', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  const again = await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  assert.equal(again.potCents, 2000);
  assert.equal(await wallet.getBalance(ids[0]!), 0); // not -1000
});

test('1v1 settle pays the winner pot − rake and books the house rake; ledger reconciles', async () => {
  const { wallet, money, ids, ledger } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  const settlement = await money.settle({ matchId: 'm1', winnerSeats: [0] });
  assert.ok(settlement);
  assert.equal(settlement!.rakeCents, 200);
  assert.equal(await wallet.getBalance(ids[0]!), 1800); // won 1800
  assert.equal(await wallet.getBalance(ids[1]!), 0);    // lost stake

  const house = (await ledger.all()).filter((t) => t.userId === HOUSE_ACCOUNT_ID);
  assert.equal(house.reduce((a, t) => a + t.amountCents, 0), 200);

  const rec = await wallet.reconcile();
  assert.equal(rec.ok, true, JSON.stringify(rec.mismatches));
});

test('2v2 settle splits the winning team’s share; whole pot is conserved', async () => {
  const { wallet, money, ids } = await setup([500, 500, 500, 500]); // 4 players, $5 each
  await money.escrow({ matchId: 'm2', type: '2v2', stakeCents: 500, rakeBps: 1000, players: players(ids) });
  // team 0 = seats {0,2} win
  const s = await money.settle({ matchId: 'm2', winnerSeats: [0, 2] });
  assert.equal(s!.rakeCents, 200);          // 10% of 2000
  assert.equal(await wallet.getBalance(ids[0]!), 900);
  assert.equal(await wallet.getBalance(ids[2]!), 900);
  assert.equal(await wallet.getBalance(ids[1]!), 0);
  assert.equal(await wallet.getBalance(ids[3]!), 0);
});

test('settle is idempotent (a second settle is a no-op)', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  await money.settle({ matchId: 'm1', winnerSeats: [0] });
  const second = await money.settle({ matchId: 'm1', winnerSeats: [0] });
  assert.equal(second, null);
  assert.equal(await wallet.getBalance(ids[0]!), 1800); // not paid twice
});

test('concurrent double-settle pays the winner exactly once (race guard)', async () => {
  // The real-world double-settle: two finalize events fire at once (e.g. a duplicate socket emit
  // or a retry overlapping the original). The inFlight guard + status flip must let only ONE win.
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  const [a, b] = await Promise.all([
    money.settle({ matchId: 'm1', winnerSeats: [0] }),
    money.settle({ matchId: 'm1', winnerSeats: [0] }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);       // exactly one settle did the work
  assert.equal(await wallet.getBalance(ids[0]!), 1800);  // winner paid once, never twice
  const rec = await wallet.reconcile();
  assert.equal(rec.ok, true);                            // ledger still balances
});

test('refund returns every stake with no rake and reconciles', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  await money.refund('m1');
  assert.equal(await wallet.getBalance(ids[0]!), 1000);
  assert.equal(await wallet.getBalance(ids[1]!), 1000);
  const rec = await wallet.reconcile();
  assert.equal(rec.ok, true);
});

test('reconcile DETECTS a balance/ledger mismatch (the invariant the periodic sweep alerts on)', async () => {
  // The happy path (reconcile ok) is covered above; this exercises the FAILURE path the 5-min
  // sweep uses to page. Introduce drift: a ledger row whose balance change was never applied
  // (simulates a lost/half-applied write) → the stored balance no longer equals the ledger sum.
  const { wallet, ids, ledger } = await setup([1000]);
  await ledger.append({ userId: ids[0]!, type: 'deposit', amountCents: 500 }); // +500 in the ledger, balance untouched
  const rec = await wallet.reconcile();
  assert.equal(rec.ok, false);
  assert.equal(rec.mismatches.length, 1);
  assert.equal(rec.mismatches[0]!.userId, ids[0]);
  assert.equal(rec.mismatches[0]!.ledgerSum, 1500);
  assert.equal(rec.mismatches[0]!.balanceCents, 1000);
});

test('free match (zero stake) escrows and settles without touching balances', async () => {
  const { wallet, money, ids } = await setup([0, 0]);
  const res = await money.escrow({ matchId: 'm0', type: '1v1', stakeCents: 0, rakeBps: 1000, players: players(ids) });
  assert.equal(res.ok, true);
  assert.equal(res.potCents, 0);
  const s = await money.settle({ matchId: 'm0', winnerSeats: [0] });
  assert.equal(s!.rakeCents, 0);
  assert.equal(await wallet.getBalance(ids[0]!), 0);
});

test('concurrent escrow for the same match never double-debits', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  const [a, b] = await Promise.all([
    money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) }),
    money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) }),
  ]);
  assert.equal(await wallet.getBalance(ids[0]!), 0); // debited exactly once (not -1000)
  assert.equal(await wallet.getBalance(ids[1]!), 0);
  assert.ok(a.ok); // first claim escrows
  assert.equal(b.ok, false); // second is rejected as busy
  assert.equal(b.code, 'busy');
});

test('per-match ledger conservation: a settled match sums to exactly zero', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  await money.settle({ matchId: 'm1', winnerSeats: [0] });
  const sums = await wallet.matchLedgerSums();
  assert.equal(sums.get('m1'), 0); // bets in === payouts + rake out
});

test('per-match ledger conservation holds after a refund too', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm2', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  await money.refund('m2');
  const sums = await wallet.matchLedgerSums();
  assert.equal(sums.get('m2'), 0);
});

test('recoverOrphanedMatches refunds an active match no live room owns (crash recovery)', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  assert.equal(await wallet.getBalance(ids[0]!), 0); // stakes escrowed

  const refunded = await money.recoverOrphanedMatches(new Set()); // boot: no live rooms
  assert.deepEqual(refunded, ['m1']);
  assert.equal(await wallet.getBalance(ids[0]!), 1000); // stake returned
  assert.equal(await wallet.getBalance(ids[1]!), 1000);
});

test('recoverOrphanedMatches leaves a genuinely in-progress match alone', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  const refunded = await money.recoverOrphanedMatches(new Set(['m1'])); // m1 is live
  assert.deepEqual(refunded, []);
  assert.equal(await wallet.getBalance(ids[0]!), 0); // still escrowed
});

test('recoverOrphanedMatches ignores already-settled matches (idempotent, no double-pay)', async () => {
  const { wallet, money, ids } = await setup([1000, 1000]);
  await money.escrow({ matchId: 'm1', type: '1v1', stakeCents: 1000, rakeBps: 1000, players: players(ids) });
  await money.settle({ matchId: 'm1', winnerSeats: [0] });
  const before = await wallet.getBalance(ids[0]!);
  const refunded = await money.recoverOrphanedMatches(new Set());
  assert.deepEqual(refunded, []); // settled => not active => untouched
  assert.equal(await wallet.getBalance(ids[0]!), before);
});

test('forfeitWinners: 1v1 other player, 2v2 opposing team, 1v1v1 the two remaining', () => {
  const p2 = [0, 1].map((seat) => ({ seat, userId: `u${seat}` }));
  assert.deepEqual(forfeitWinners('1v1', p2, 0, [[0, 2], [1, 3]]), [1]);

  const p4 = [0, 1, 2, 3].map((seat) => ({ seat, userId: `u${seat}` }));
  assert.deepEqual(forfeitWinners('2v2', p4, 0, [[0, 2], [1, 3]]), [1, 3]); // seat 0 (team0) abandons -> team1
  assert.deepEqual(forfeitWinners('2v2', p4, 1, [[0, 2], [1, 3]]), [0, 2]);

  const p3 = [0, 1, 2].map((seat) => ({ seat, userId: `u${seat}` }));
  assert.deepEqual(forfeitWinners('1v1v1', p3, 1, [[0, 2], [1, 3]]), [0, 2]);
});
