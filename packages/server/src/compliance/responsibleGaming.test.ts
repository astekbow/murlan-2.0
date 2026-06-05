import test from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction, TransactionType } from '../money/ledger.ts';
import { InMemoryLedger } from '../money/ledger.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { WalletService } from '../money/walletService.ts';
import { depositsToday, netResultToday, ResponsibleGamingService } from './responsibleGaming.ts';

const DAY = 86_400_000;
const NOW = 20_000 * DAY + 5_000; // some fixed "today"
const tx = (type: TransactionType, amountCents: number, createdAt: number): Transaction =>
  ({ id: `${type}_${amountCents}_${createdAt}`, userId: 'u', type, amountCents, currency: 'USD', status: 'completed', providerRef: null, matchId: null, reason: null, createdAt });

test('depositsToday sums only today\'s deposits', () => {
  const txs = [
    tx('deposit', 5000, NOW),
    tx('deposit', 3000, NOW - 1000),     // today
    tx('deposit', 9999, NOW - 2 * DAY),  // a previous day — excluded
    tx('bet', -4000, NOW),               // not a deposit — excluded
  ];
  assert.equal(depositsToday(txs, NOW), 8000);
});

test('netResultToday nets bets (−) against payouts (+) for today only', () => {
  const txs = [
    tx('bet', -1000, NOW),
    tx('bet', -1000, NOW),
    tx('payout', 1500, NOW),
    tx('payout', 9999, NOW - DAY), // yesterday — excluded
    tx('deposit', 5000, NOW),      // deposits don't count as gambling result
  ];
  assert.equal(netResultToday(txs, NOW), -500); // -1000 -1000 +1500
});

async function setup() {
  const users = new InMemoryUserRepository();
  const wallet = new WalletService(users, new InMemoryLedger());
  const rg = new ResponsibleGamingService(users, wallet);
  const u = await users.create({ username: 'p', email: 'p@p.com', passwordHash: 'h' });
  return { users, wallet, rg, id: u.id };
}

test('no limits set ⇒ everything allowed', async () => {
  const { rg, id } = await setup();
  assert.equal((await rg.checkDeposit(id, 1_000_000)).allowed, true);
  assert.equal((await rg.checkLoss(id)).allowed, true);
});

test('deposit limit blocks once the day total would exceed the cap', async () => {
  const { rg, wallet, id } = await setup();
  await rg.setLimits(id, { dailyDepositLimitCents: 10_000 }); // $100/day
  await wallet.credit(id, 6_000, { type: 'deposit' });        // $60 already deposited today
  assert.equal((await rg.checkDeposit(id, 4_000)).allowed, true);  // 60+40 = 100 (at cap, allowed)
  const over = await rg.checkDeposit(id, 4_001);                   // 60+40.01 > 100
  assert.equal(over.allowed, false);
  assert.equal(over.code, 'deposit_limit');
});

test('loss limit blocks staked play once today\'s net loss reaches the cap', async () => {
  const { rg, wallet, id } = await setup();
  await rg.setLimits(id, { dailyLossLimitCents: 5_000 }); // $50/day
  await wallet.credit(id, 20_000, { type: 'deposit' });   // fund the account
  assert.equal((await rg.checkLoss(id)).allowed, true);    // no loss yet
  await wallet.debit(id, 5_000, { type: 'bet', matchId: 'm1' }); // lost $50 (no payout)
  const hit = await rg.checkLoss(id);
  assert.equal(hit.allowed, false);
  assert.equal(hit.code, 'loss_limit');
});

test('setLimits: a positive cap is floored; ≤0 / non-finite means "no limit"; null clears', async () => {
  const { rg, id } = await setup();
  let lim = await rg.setLimits(id, { dailyDepositLimitCents: -50, dailyLossLimitCents: 12.9 });
  assert.equal(lim.dailyDepositLimitCents, null); // ≤0 ⇒ no limit (not a "block everything" 0)
  assert.equal(lim.dailyLossLimitCents, 12);       // positive ⇒ floored
  lim = await rg.setLimits(id, { dailyDepositLimitCents: 5000 });
  assert.equal(lim.dailyDepositLimitCents, 5000);
  assert.equal(lim.dailyLossLimitCents, 12);        // untouched (undefined patch field)
  lim = await rg.setLimits(id, { dailyLossLimitCents: null });
  assert.equal(lim.dailyLossLimitCents, null);      // explicit null clears
  assert.equal(lim.dailyDepositLimitCents, 5000);
});

test('a 0 loss limit does NOT block all staked play (treated as no limit)', async () => {
  const { rg, id } = await setup();
  await rg.setLimits(id, { dailyLossLimitCents: 0 });
  assert.equal((await rg.checkLoss(id)).allowed, true); // 0 ⇒ no limit, not "block everything"
});
