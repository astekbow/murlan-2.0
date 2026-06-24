import test from 'node:test';
import assert from 'node:assert/strict';
import { RewardsService, COSMETICS, type PurchaseWallet } from './rewardsService.ts';
import { InsufficientFundsError } from '../money/walletService.ts';
import { InMemoryUserRepository, type UserRepository, type User } from '../auth/userRepository.ts';
import { levelInfo } from '../profile/level.ts';

const GOLD = COSMETICS.find((c) => c.id === 'cb_gold')!; // a paid cosmetic ($3.00); paid[0]
const XP_ITEM = COSMETICS.find((c) => (c.costXp ?? 0) > 0)!; // an XP-priced cosmetic
// Day 1: the daily deal is paid[1] (cb_emerald), so cb_gold is FULL price here — keeps the
// price-assertion tests deterministic regardless of the real calendar day.
const DAY1 = 86_400_000;
// Day 0: the daily deal is paid[0] = cb_gold, so it's discounted here.
const DAY_GOLD_DEAL = 0;

/** Recording wallet: captures debits + refund-credits so we can assert the
 *  real-money buy path charges once and never charges for nothing. */
class FakeWallet implements PurchaseWallet {
  debits: Array<{ userId: string; cents: number }> = [];
  credits: Array<{ userId: string; cents: number }> = [];
  failDebit = false;
  async debit(userId: string, cents: number): Promise<unknown> {
    if (this.failDebit) throw new InsufficientFundsError(userId, cents, 0);
    this.debits.push({ userId, cents });
    return {};
  }
  async credit(userId: string, cents: number): Promise<unknown> {
    this.credits.push({ userId, cents });
    return {};
  }
}

/** Minimal user store covering only what buy() touches. `grantOk:false` forces
 *  purchaseCosmetic to reject — simulating a lost grant race / failed write. */
function fakeUsers(opts: { owned?: string[]; grantOk?: boolean } = {}) {
  const user = { id: 'u1', cosmetics: [...(opts.owned ?? [])] } as unknown as User;
  const grantOk = opts.grantOk ?? true;
  const users = {
    async findById(id: string) { return id === 'u1' ? user : null; },
    async purchaseCosmetic(_userId: string, cosmeticId: string) {
      if (!grantOk) return { ok: false, code: 'owned' };
      if (user.cosmetics.includes(cosmeticId)) return { ok: false, code: 'owned' };
      user.cosmetics.push(cosmeticId);
      return { ok: true };
    },
  } as unknown as UserRepository;
  return { users, user };
}

test('buy debits once then grants the cosmetic', async () => {
  const wallet = new FakeWallet();
  const { users, user } = fakeUsers();
  const rewards = new RewardsService(users, true, wallet);
  const res = await rewards.buy('u1', GOLD.id, DAY1);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(wallet.debits, [{ userId: 'u1', cents: GOLD.cost }]);
  assert.deepEqual(wallet.credits, []); // no refund
  assert.ok(user.cosmetics.includes(GOLD.id));
});

test('buy returns insufficient_funds and does NOT grant when the wallet is short', async () => {
  const wallet = new FakeWallet();
  wallet.failDebit = true;
  const { users, user } = fakeUsers();
  const rewards = new RewardsService(users, true, wallet);
  const res = await rewards.buy('u1', GOLD.id, DAY1);
  assert.deepEqual(res, { ok: false, code: 'insufficient_funds' });
  assert.deepEqual(wallet.debits, []);
  assert.ok(!user.cosmetics.includes(GOLD.id));
});

test('buy REFUNDS the charge if the grant fails (never charged for nothing)', async () => {
  const wallet = new FakeWallet();
  const { users } = fakeUsers({ grantOk: false }); // grant always rejects (race)
  const rewards = new RewardsService(users, true, wallet);
  const res = await rewards.buy('u1', GOLD.id, DAY1);
  assert.equal(res.ok, false);
  assert.deepEqual(wallet.debits, [{ userId: 'u1', cents: GOLD.cost }]);
  assert.deepEqual(wallet.credits, [{ userId: 'u1', cents: GOLD.cost }]); // refunded
});

test('buy rejects an already-owned cosmetic before charging', async () => {
  const wallet = new FakeWallet();
  const { users } = fakeUsers({ owned: [GOLD.id] });
  const rewards = new RewardsService(users, true, wallet);
  const res = await rewards.buy('u1', GOLD.id, DAY1);
  assert.deepEqual(res, { ok: false, code: 'owned' });
  assert.deepEqual(wallet.debits, []);
  assert.deepEqual(wallet.credits, []);
});

test('buy charges the DISCOUNTED daily-deal price (enforced server-side)', async () => {
  const wallet = new FakeWallet();
  const { users, user } = fakeUsers();
  const rewards = new RewardsService(users, true, wallet);
  // On DAY_GOLD_DEAL the deal item is cb_gold → 20% off 300 = 240, charged server-side.
  const res = await rewards.buy('u1', GOLD.id, DAY_GOLD_DEAL);
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(wallet.debits, [{ userId: 'u1', cents: Math.round(GOLD.cost * 0.8) }]);
  assert.ok(user.cosmetics.includes(GOLD.id));
});

// ---- XP economy (parallel to money; never touches the wallet) ----------------

/** Real in-memory repo seeded with `xp` lifetime XP (so the atomic xpSpent path runs). */
async function xpSetup(xp: number) {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'xp', email: 'xp@x.com', passwordHash: 'h' });
  await users.addXp(u.id, xp);
  return { users, userId: u.id };
}

test('buyXp deducts xpSpent (NOT the wallet) and grants the cosmetic; level is unaffected', async () => {
  const wallet = new FakeWallet();
  const { users, userId } = await xpSetup(10_000);
  const before = await users.findById(userId);
  const levelBefore = levelInfo(before!.xp).level;

  const rewards = new RewardsService(users, true, wallet);
  const res = await rewards.buyXp(userId, XP_ITEM.id);
  assert.deepEqual(res, { ok: true });

  const after = await users.findById(userId);
  assert.ok(after!.cosmetics.includes(XP_ITEM.id), 'cosmetic granted');
  assert.equal(after!.xpSpent, XP_ITEM.costXp, 'xpSpent increased by the XP price');
  assert.equal(after!.xp, before!.xp, 'lifetime xp is unchanged (level stays monotonic)');
  assert.equal(levelInfo(after!.xp).level, levelBefore, 'level is unaffected by an XP purchase');
  assert.deepEqual(wallet.debits, [], 'the wallet was NOT debited');
  assert.deepEqual(wallet.credits, []);
});

test('buyXp rejects when spendable XP is insufficient (no grant, no wallet touch)', async () => {
  const wallet = new FakeWallet();
  const { users, userId } = await xpSetup((XP_ITEM.costXp ?? 0) - 1); // one short
  const rewards = new RewardsService(users, true, wallet);
  const res = await rewards.buyXp(userId, XP_ITEM.id);
  assert.deepEqual(res, { ok: false, code: 'insufficient_xp' });

  const after = await users.findById(userId);
  assert.ok(!after!.cosmetics.includes(XP_ITEM.id), 'not granted');
  assert.equal(after!.xpSpent, 0, 'nothing spent');
  assert.deepEqual(wallet.debits, []);
});

test('status exposes spendableXp = xp - xpSpent (clamped) and costXp on XP items', async () => {
  const wallet = new FakeWallet();
  const { users, userId } = await xpSetup(5_000);
  const rewards = new RewardsService(users, true, wallet);
  await rewards.buyXp(userId, XP_ITEM.id);

  const status = await rewards.status(userId, DAY1);
  assert.equal(status!.spendableXp, 5_000 - (XP_ITEM.costXp ?? 0));
  const shopItem = status!.shop.find((s) => s.id === XP_ITEM.id)!;
  assert.equal(shopItem.costXp, XP_ITEM.costXp);
  assert.equal(shopItem.cost, 0, 'an XP item carries money cost 0');
  assert.ok(shopItem.owned, 'now owned after the XP buy');
});

test('a money buy still debits the wallet; buy refuses an XP item (wrong currency)', async () => {
  const wallet = new FakeWallet();
  const { users, userId } = await xpSetup(50_000); // plenty of XP, but money buy must still hit the wallet
  const rewards = new RewardsService(users, true, wallet);

  const money = await rewards.buy(userId, GOLD.id, DAY1); // cb_gold is full price on DAY1
  assert.deepEqual(money, { ok: true });
  assert.deepEqual(wallet.debits, [{ userId, cents: GOLD.cost }], 'wallet debited for the money item');
  const afterMoney = await users.findById(userId);
  assert.equal(afterMoney!.xpSpent, 0, 'a money buy never spends XP');

  // buy() must refuse an XP-priced item (it would otherwise wrongly charge the wallet).
  const wrong = await rewards.buy(userId, XP_ITEM.id, DAY1);
  assert.deepEqual(wrong, { ok: false, code: 'wrong_currency' });
});
