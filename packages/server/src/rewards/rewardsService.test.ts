import test from 'node:test';
import assert from 'node:assert/strict';
import { RewardsService, COSMETICS, type PurchaseWallet } from './rewardsService.ts';
import { InsufficientFundsError } from '../money/walletService.ts';
import { InMemoryUserRepository, type UserRepository, type User } from '../auth/userRepository.ts';
import { levelInfo } from '../profile/level.ts';
import { dailyQuestsFor, weeklyQuestsFor, MILESTONE_STEP, milestoneFor, DAILY_POOL } from './quests.ts';

const DAILY_POOL_IDS = DAILY_POOL.map((q) => q.id);

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

// ---- Rotating quests (daily + weekly) & level-up rewards (the retention core) ----

const MON = Date.UTC(2026, 5, 22, 12, 0, 0);  // 2026-06-22, ISO 2026-W26
const NEXT_DAY = Date.UTC(2026, 5, 23, 12, 0, 0);
const NEXT_WEEK = Date.UTC(2026, 5, 29, 12, 0, 0); // 2026-W27

// MON daily pool (deterministic): d_play4(games=4), d_play2(games=2), d_win3(wins=3) — all
// COUNT-based, so they exercise the per-period delta. MON weekly pool: w_level(level=1),
// w_win10(wins=10), w_win20(wins=20).

/** Play `n` matches (all wins by default) for a user via the stats path. */
async function play(users: InMemoryUserRepository, id: string, n: number, won = true) {
  for (let i = 0; i < n; i++) await users.applyMatchResult(id, { won, potCents: 0, xpGain: 0 });
}

/** Fresh service + a real in-memory user (no games yet → anchors unset). */
async function questSetup() {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'q', email: 'q@x.com', passwordHash: 'h' });
  const rewards = new RewardsService(users, true, new FakeWallet());
  return { users, rewards, userId: u.id };
}

test('status exposes today\'s daily + this week\'s weekly quests (matching the pools)', async () => {
  const { rewards, userId } = await questSetup();
  const status = (await rewards.status(userId, MON))!;
  assert.deepEqual(status.dailyQuests.map((q) => q.id), dailyQuestsFor(MON).map((q) => q.id));
  assert.deepEqual(status.weeklyQuests.map((q) => q.id), weeklyQuestsFor(MON).map((q) => q.id));
});

test('count-based daily progress is PER-DAY: lifetime games do NOT pre-complete it', async () => {
  const { users, rewards, userId } = await questSetup();
  // High LIFETIME activity (already played 50) — but BEFORE today's anchor exists.
  await play(users, userId, 50);
  // First status read of the day snapshots the anchor at games=50 → today's progress is 0.
  const fresh = (await rewards.status(userId, MON))!;
  const play4 = fresh.dailyQuests.find((q) => q.id === 'd_play4')!;
  assert.equal(play4.progress, 0, 'a fresh day starts a count quest at 0 despite 50 lifetime games');
  assert.equal(play4.done, false);

  // Playing TODAY advances it; 4 plays after the anchor completes "play 4 today".
  await play(users, userId, 4);
  const after = (await rewards.status(userId, MON))!;
  assert.equal(after.dailyQuests.find((q) => q.id === 'd_play4')!.progress, 4);
  assert.ok(after.dailyQuests.find((q) => q.id === 'd_play4')!.done);
  // And it's now claimable.
  assert.deepEqual(await rewards.claimDailyQuest(userId, 'd_play4', MON), { rewardXp: 45 });
});

test('a daily quest claims ONCE per day, then is fresh again the next day', async () => {
  const { users, rewards, userId } = await questSetup();
  // Establish today's anchor (games=0), then play enough for d_play4 (goal 4).
  await rewards.status(userId, MON);
  await play(users, userId, 4);

  const first = await rewards.claimDailyQuest(userId, 'd_play4', MON);
  assert.deepEqual(first, { rewardXp: 45 });
  // Second claim SAME day → null (already claimed).
  assert.equal(await rewards.claimDailyQuest(userId, 'd_play4', MON), null);
  // Reflected in status for that day.
  const sameDay = (await rewards.status(userId, MON))!;
  assert.ok(sameDay.dailyQuests.find((q) => q.id === 'd_play4')!.claimed);

  // Next UTC day → the pool rotates AND the anchor rolls over (count progress resets to 0).
  const tomorrowStatus = (await rewards.status(userId, NEXT_DAY))!;
  const playQuest = tomorrowStatus.dailyQuests.find((q) => q.id === 'd_play6'); // NEXT_DAY pool
  if (playQuest) {
    assert.equal(playQuest.claimed, false, 'claim resets next day');
    assert.equal(playQuest.progress, 0, 'count progress resets next day (anchor rolled over)');
  }
});

test('claimDailyQuest refuses a quest NOT in today\'s pool', async () => {
  const { users, rewards, userId } = await questSetup();
  await rewards.status(userId, MON);
  await play(users, userId, 30);
  const todayIds = new Set(dailyQuestsFor(MON).map((q) => q.id));
  const notToday = DAILY_POOL_IDS.find((id) => !todayIds.has(id));
  if (notToday) assert.equal(await rewards.claimDailyQuest(userId, notToday, MON), null);
});

test('a weekly quest claims ONCE per ISO week, fresh again next week', async () => {
  const { users, rewards, userId } = await questSetup();
  // w_win10 needs 10 wins THIS week. Establish the weekly anchor, then win 10.
  await rewards.status(userId, MON);
  await play(users, userId, 10, true);

  const first = await rewards.claimWeeklyQuest(userId, 'w_win10', MON);
  assert.deepEqual(first, { rewardXp: 200 });
  assert.equal(await rewards.claimWeeklyQuest(userId, 'w_win10', MON), null, 'no double claim same week');

  // Next ISO week → anchor rolls over; the within-week win count resets to 0.
  const nextWeekStatus = (await rewards.status(userId, NEXT_WEEK))!;
  const winQuest = nextWeekStatus.weeklyQuests.find((q) => q.id === 'w_play20'); // NEXT_WEEK pool
  if (winQuest) assert.equal(winQuest.progress, 0, 'within-week progress resets next ISO week');
});

test('claimDailyQuest rejects an INCOMPLETE quest (per-day goal not met)', async () => {
  const { users, rewards, userId } = await questSetup();
  // 50 lifetime games but the anchor snapshots them → 0 progress today, so not claimable.
  await play(users, userId, 50);
  await rewards.status(userId, MON); // sets anchor at games=50
  assert.equal(await rewards.claimDailyQuest(userId, 'd_play4', MON), null, 'lifetime games do not satisfy a per-day quest');
  // Play only 2 today → still short of the goal of 4.
  await play(users, userId, 2);
  assert.equal(await rewards.claimDailyQuest(userId, 'd_play4', MON), null, 'still incomplete (2 < 4)');
});

test('rollover snapshots a FRESH anchor lazily and persists it', async () => {
  const { users, rewards, userId } = await questSetup();
  await play(users, userId, 12);
  // No anchor yet.
  assert.equal((await users.findById(userId))!.dailyAnchor, null);
  await rewards.status(userId, MON);
  const a = (await users.findById(userId))!.dailyAnchor!;
  assert.deepEqual(a, { period: '2026-06-22', games: 12, wins: 12 }, 'anchor snapshots current stats on first read');

  // A read the SAME day does not move the anchor (even after more play).
  await play(users, userId, 3);
  await rewards.status(userId, MON);
  assert.deepEqual((await users.findById(userId))!.dailyAnchor, { period: '2026-06-22', games: 12, wins: 12 });

  // A read the NEXT day rolls the anchor forward to the now-current stats (15 games).
  await rewards.status(userId, NEXT_DAY);
  assert.deepEqual((await users.findById(userId))!.dailyAnchor, { period: '2026-06-23', games: 15, wins: 15 });
});

test('level milestone reward is granted ONCE (idempotent) and collects in order', async () => {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'lvl', email: 'lvl@x.com', passwordHash: 'h' });
  const rewards = new RewardsService(users, true, new FakeWallet());
  // Push XP high enough to clear several milestones at once (level 10 needs xp ≥ 8100).
  await users.addXp(u.id, 12_000);
  const before = await users.findById(u.id);
  const startLevel = levelInfo(before!.xp).level;
  assert.ok(startLevel >= MILESTONE_STEP * 2, 'reached at least the 2nd milestone');

  // First claim → the LOWEST uncollected milestone (level === MILESTONE_STEP).
  const first = await rewards.claimLevelReward(u.id);
  assert.equal(first!.level, MILESTONE_STEP, 'collects the earliest milestone first');
  const m1 = milestoneFor(MILESTONE_STEP)!;
  const afterFirst = await users.findById(u.id);
  assert.ok(afterFirst!.collectedMilestones.includes(MILESTONE_STEP), 'recorded as collected');
  assert.equal(afterFirst!.xp, before!.xp + m1.bonusXp, 'bonus XP granted');
  if (m1.cosmeticId) assert.ok(afterFirst!.cosmetics.includes(m1.cosmeticId), 'free cosmetic granted');

  // Second claim → the NEXT milestone (level === MILESTONE_STEP*2).
  const second = await rewards.claimLevelReward(u.id);
  assert.equal(second!.level, MILESTONE_STEP * 2);

  // Drain remaining reachable milestones, then a further claim is null (idempotent: nothing left).
  let guard = 0;
  while (await rewards.claimLevelReward(u.id)) { if (++guard > 50) break; }
  assert.equal(await rewards.claimLevelReward(u.id), null, 'nothing left to collect');

  // collectedMilestones has no duplicates.
  const final = await users.findById(u.id);
  assert.equal(new Set(final!.collectedMilestones).size, final!.collectedMilestones.length);
});

test('no level reward is pending below the first milestone', async () => {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'low', email: 'low@x.com', passwordHash: 'h' });
  const rewards = new RewardsService(users, true, new FakeWallet());
  const status = (await rewards.status(u.id, MON))!; // level 1, no XP
  assert.equal(status.levelReward, null);
  assert.equal(await rewards.claimLevelReward(u.id), null);
});

// ---- Achievements / badges (granted lazily in status when a threshold is crossed) -----

test('status grants an achievement badge ONCE when its stat threshold is crossed (not twice)', async () => {
  const wallet = new FakeWallet();
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'ach', email: 'ach@x.com', passwordHash: 'h' });
  const rewards = new RewardsService(users, true, wallet);

  // No wins yet → no first_win badge, and the achievement reads as not earned.
  let status = await rewards.status(u.id, DAY1);
  assert.ok(!status!.achievements.find((a) => a.id === 'first_win')!.earned);
  assert.deepEqual((await users.findById(u.id))!.badges, []);

  // Cross the threshold: one win.
  await users.applyMatchResult(u.id, { won: true, potCents: 0, xpGain: 0 });

  status = await rewards.status(u.id, DAY1);
  assert.ok(status!.achievements.find((a) => a.id === 'first_win')!.earned, 'first_win now earned');
  assert.deepEqual((await users.findById(u.id))!.badges, ['first_win'], 'badge granted once');

  // A SECOND status read must not duplicate the badge (idempotent grant).
  await rewards.status(u.id, DAY1);
  assert.deepEqual((await users.findById(u.id))!.badges, ['first_win'], 'no duplicate on re-read');
});

test('multiple thresholds crossed at once each grant exactly one badge', async () => {
  const wallet = new FakeWallet();
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'multi', email: 'multi@x.com', passwordHash: 'h' });
  const rewards = new RewardsService(users, true, wallet);

  // 10 wins in a row ⇒ first_win, wins_10, streak_5 are all met together.
  for (let i = 0; i < 10; i += 1) await users.applyMatchResult(u.id, { won: true, potCents: 0, xpGain: 0 });
  await rewards.status(u.id, DAY1);

  const badges = (await users.findById(u.id))!.badges;
  assert.ok(badges.includes('first_win'));
  assert.ok(badges.includes('wins_10'));
  assert.ok(badges.includes('streak_5'));
  assert.ok(badges.includes('streak_10'));
  // No duplicates.
  assert.equal(new Set(badges).size, badges.length, 'badge ids are unique');
});

test('a reset streak does NOT remove an already-earned streak badge (append-only)', async () => {
  const wallet = new FakeWallet();
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'streak', email: 'streak@x.com', passwordHash: 'h' });
  const rewards = new RewardsService(users, true, wallet);

  for (let i = 0; i < 5; i += 1) await users.applyMatchResult(u.id, { won: true, potCents: 0, xpGain: 0 });
  await rewards.status(u.id, DAY1);
  assert.ok((await users.findById(u.id))!.badges.includes('streak_5'), 'earned at streak 5');

  // A loss resets currentStreak to 0, but the badge stays.
  await users.applyMatchResult(u.id, { won: false, potCents: 0, xpGain: 0 });
  await rewards.status(u.id, DAY1);
  assert.ok((await users.findById(u.id))!.badges.includes('streak_5'), 'badge retained after reset');
});
