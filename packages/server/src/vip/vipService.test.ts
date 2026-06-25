import test from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction, TransactionType } from '../money/ledger.ts';
import { InMemoryLedger } from '../money/ledger.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { WalletService } from '../money/walletService.ts';
import { stakedVolume, vipTierFor, VipService, vipXpMultiplier, VIP_TIERS } from './vipService.ts';

const tx = (type: TransactionType, amountCents: number): Transaction =>
  ({ id: `${type}${amountCents}`, userId: 'u', type, amountCents, currency: 'USD', status: 'completed', providerRef: null, matchId: null, reason: null, createdAt: 0 });

test('stakedVolume sums |bet| only', () => {
  assert.equal(stakedVolume([tx('bet', -1000), tx('bet', -2000), tx('payout', 2500), tx('deposit', 9999)]), 3000);
});

test('vipTierFor maps staked volume to the right tier', () => {
  assert.equal(vipTierFor(0).key, 'standard');
  assert.equal(vipTierFor(9_999).key, 'standard');
  assert.equal(vipTierFor(10_000).key, 'bronze');
  assert.equal(vipTierFor(100_000).key, 'silver');
  assert.equal(vipTierFor(1_000_000).key, 'gold');
  assert.equal(vipTierFor(9_999_999).key, 'diamond');
});

test('vipXpMultiplier scales match XP by tier (a real perk; no rake-back)', () => {
  const byKey = (k: string) => VIP_TIERS.find((t) => t.key === k)!;
  assert.equal(vipXpMultiplier(byKey('standard')), 1);
  assert.equal(vipXpMultiplier(byKey('bronze')), 1.1);
  assert.equal(vipXpMultiplier(byKey('silver')), 1.2);
  assert.equal(vipXpMultiplier(byKey('gold')), 1.35);
  assert.equal(vipXpMultiplier(byKey('diamond')), 1.5);
});

test('getStatus derives tier + progress from the ledger', async () => {
  const users = new InMemoryUserRepository();
  const wallet = new WalletService(users, new InMemoryLedger());
  const vip = new VipService(wallet);
  const u = await users.create({ username: 'p', email: 'p@p.com', passwordHash: 'h' });
  await wallet.credit(u.id, 50_000, { type: 'deposit' });          // deposits don't count
  await wallet.debit(u.id, 12_000, { type: 'bet', matchId: 'm1' }); // $120 staked → bronze

  const s = await vip.getStatus(u.id);
  assert.equal(s.stakedCents, 12_000);
  assert.equal(s.tier.key, 'bronze');
  assert.equal(s.next!.key, 'silver');
  assert.equal(s.toNextCents, 100_000 - 12_000);

  // A brand-new player is Standard with no staked volume.
  const fresh = await vip.getStatus('nobody');
  assert.equal(fresh.tier.key, 'standard');
  assert.equal(fresh.stakedCents, 0);
});
