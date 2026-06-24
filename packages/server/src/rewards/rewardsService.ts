// ============================================================================
// MURLAN — Engagement rewards (Phase 6, §2.6)
// ----------------------------------------------------------------------------
// Daily login + challenges grant XP (never cashable). The cosmetic SHOP is bought
// with the real wallet balance (a 'purchase' ledger debit) — `cost` is a price in
// CENTS. Cosmetics are owned flags only, never refundable to cash, so this stays
// clean. Gated by the `enabled` flag (per-jurisdiction off switch).
// ============================================================================

import type { UserRepository, User } from '../auth/userRepository.ts';
import { levelInfo } from '../profile/level.ts';
import { InsufficientFundsError } from '../money/walletService.ts';
import {
  dailyQuestsFor, weeklyQuestsFor, dailyClaimKey, weeklyClaimKey,
  utcDayKey, isoWeekKey, effectiveAnchor, questPeriodProgress,
  milestoneFor, MILESTONE_STEP,
  type QuestDef, type PeriodAnchor,
} from './quests.ts';
import { ACHIEVEMENTS, achievementValue, newlyEarnedAchievements } from './achievements.ts';

/** The wallet capability the shop needs: debit to charge, credit to REFUND a charge
 *  whose cosmetic grant then failed (so a player is never charged for nothing). */
export interface PurchaseWallet {
  debit(userId: string, amountCents: number, opts: { type: 'purchase'; reason?: string }): Promise<unknown>;
  credit(userId: string, amountCents: number, opts: { type: 'purchase'; reason?: string }): Promise<unknown>;
}

export type CosmeticType = 'cardBack' | 'tableFelt';
export interface Cosmetic {
  id: string;
  name: string;
  type: CosmeticType;
  // PRICE IN CENTS (wallet money); 0 = free/default (always owned) OR an XP-priced item.
  cost: number;
  // When set (> 0), this is an XP-PRICED item: bought with spendable XP (xp - xpSpent),
  // NEVER the wallet, and its money `cost` is treated as 0. Mutually exclusive with `cost`.
  costXp?: number;
  featured?: boolean; // show a "NEW" badge (owner-curated, not date-based)
}

/** True when an item is bought with XP (costXp set) rather than wallet money. */
function isXpPriced(c: Cosmetic): boolean {
  return (c.costXp ?? 0) > 0;
}

// Daily deal: one paid cosmetic per UTC day at a fixed % off. Deterministic (day-indexed)
// so the client + server agree, and the discount is enforced in buy() — never trusted
// from the client.
const DEAL_PCT = 20;
function dealPriceCents(cost: number): number {
  return Math.round((cost * (100 - DEAL_PCT)) / 100);
}
function dailyDealId(now: number): string | null {
  const paid = COSMETICS.filter((c) => c.cost > 0);
  if (paid.length === 0) return null;
  return paid[Math.floor(now / DAY_MS) % paid.length]!.id;
}

// "Some XP, some money" (owner's call): the PREMIUM card-backs/felts stay MONEY-priced
// (cost in cents); several mid/lower cosmetics are XP-PRICED (costXp, bought with spendable
// XP — never the wallet). New items added below: a few XP-priced + a couple money-priced.
// An XP item carries cost:0 (so it's excluded from the money-only daily deal automatically).
export const COSMETICS: Cosmetic[] = [
  // ── Card backs ──────────────────────────────────────────────────────────
  { id: 'cb_classic', name: 'Pas klasik', type: 'cardBack', cost: 0 },
  // XP-priced (earned from play/challenges) — prices LOWERED so a few sessions unlock them.
  { id: 'cb_ivory', name: 'Pas fildishi', type: 'cardBack', cost: 0, costXp: 150 },
  { id: 'cb_ocean', name: 'Pas oqeani', type: 'cardBack', cost: 0, costXp: 250 },
  { id: 'cb_crimson', name: 'Pas të kuq', type: 'cardBack', cost: 0, costXp: 250 },
  { id: 'cb_emerald', name: 'Pas smerald', type: 'cardBack', cost: 0, costXp: 350 },
  { id: 'cb_sunset', name: 'Pas perëndimi', type: 'cardBack', cost: 0, costXp: 350 },
  { id: 'cb_sapphire', name: 'Pas safir', type: 'cardBack', cost: 0, costXp: 500 },
  { id: 'cb_violet', name: 'Pas vjollcë', type: 'cardBack', cost: 0, costXp: 500 },
  { id: 'cb_rose', name: 'Pas trëndafili', type: 'cardBack', cost: 0, costXp: 800 },
  { id: 'cb_jade', name: 'Pas jadeje', type: 'cardBack', cost: 0, costXp: 1200 },
  // Money-priced (premium)
  { id: 'cb_gold', name: 'Pas ari', type: 'cardBack', cost: 300 },
  { id: 'cb_carbon', name: 'Pas karboni', type: 'cardBack', cost: 500 },
  { id: 'cb_royal', name: 'Pas mbretëror', type: 'cardBack', cost: 600, featured: true },
  { id: 'cb_platinum', name: 'Pas platini', type: 'cardBack', cost: 800, featured: true },
  // ── Table felts ─────────────────────────────────────────────────────────
  { id: 'felt_red', name: 'Çoha e kuqe', type: 'tableFelt', cost: 0 },
  // XP-priced
  { id: 'felt_charcoal', name: 'Çoha qymyr', type: 'tableFelt', cost: 0, costXp: 150 },
  { id: 'felt_forest', name: 'Çoha pyll', type: 'tableFelt', cost: 0, costXp: 250 },
  { id: 'felt_teal', name: 'Çoha bruz', type: 'tableFelt', cost: 0, costXp: 250 },
  { id: 'felt_sand', name: 'Çoha rëre', type: 'tableFelt', cost: 0, costXp: 250 },
  { id: 'felt_emerald', name: 'Çoha smerald', type: 'tableFelt', cost: 0, costXp: 350 },
  { id: 'felt_sapphire', name: 'Çoha safir', type: 'tableFelt', cost: 0, costXp: 500 },
  { id: 'felt_plum', name: 'Çoha kumbull', type: 'tableFelt', cost: 0, costXp: 500 },
  { id: 'felt_amber', name: 'Çoha qelibar', type: 'tableFelt', cost: 0, costXp: 800 },
  // Money-priced (premium)
  { id: 'felt_wine', name: 'Çoha verë', type: 'tableFelt', cost: 450 },
  { id: 'felt_obsidian', name: 'Çoha obsidian', type: 'tableFelt', cost: 600 },
  { id: 'felt_midnight', name: 'Çoha mesnatë', type: 'tableFelt', cost: 700, featured: true },
  { id: 'felt_royalblue', name: 'Çoha blu mbretërore', type: 'tableFelt', cost: 900, featured: true },
];

type Metric = 'gamesPlayed' | 'wins' | 'level' | 'currentStreak';
interface ChallengeDef {
  id: string;
  title: string;
  goal: number;
  metric: Metric;
  rewardXp: number;
}
const CHALLENGES: ChallengeDef[] = [
  { id: 'play3', title: 'Luaj 3 lojëra', goal: 3, metric: 'gamesPlayed', rewardXp: 30 },
  { id: 'win1', title: 'Fito një lojë', goal: 1, metric: 'wins', rewardXp: 40 },
  { id: 'win5', title: 'Fito 5 lojëra', goal: 5, metric: 'wins', rewardXp: 90 },
  { id: 'level3', title: 'Arri Nivelin 3', goal: 3, metric: 'level', rewardXp: 60 },
  { id: 'streak3', title: 'Seri 3 fitore', goal: 3, metric: 'currentStreak', rewardXp: 70 },
  // More ways to earn XP (achievable, consistent with the structure above).
  { id: 'play10', title: 'Luaj 10 lojëra', goal: 10, metric: 'gamesPlayed', rewardXp: 120 },
  { id: 'play25', title: 'Luaj 25 lojëra', goal: 25, metric: 'gamesPlayed', rewardXp: 250 },
  { id: 'win10', title: 'Fito 10 lojëra', goal: 10, metric: 'wins', rewardXp: 180 },
  { id: 'win25', title: 'Fito 25 lojëra', goal: 25, metric: 'wins', rewardXp: 400 },
  { id: 'level5', title: 'Arri Nivelin 5', goal: 5, metric: 'level', rewardXp: 150 },
  { id: 'level10', title: 'Arri Nivelin 10', goal: 10, metric: 'level', rewardXp: 350 },
  { id: 'streak5', title: 'Seri 5 fitore', goal: 5, metric: 'currentStreak', rewardXp: 140 },
];

const DAY_MS = 86_400_000;
const dayIndex = (ms: number): number => Math.floor(ms / DAY_MS);
const dailyReward = (streak: number): number => 25 + 5 * Math.min(Math.max(streak, 1) - 1, 6); // 25..55

function metricValue(u: User, m: Metric): number {
  if (m === 'level') return levelInfo(u.xp).level;
  return u[m];
}

export interface RewardsStatus {
  enabled: boolean;
  xp: number;
  level: number;
  /** Spendable XP balance for the XP shop = max(0, xp - xpSpent). Lifetime `xp` is unchanged. */
  spendableXp: number;
  daily: { canClaim: boolean; streak: number; rewardXp: number };
  challenges: Array<{ id: string; title: string; goal: number; progress: number; done: boolean; claimed: boolean; rewardXp: number }>;
  // Rotating DAILY quests (today's pool; rotate at UTC midnight). Same progress/claim
  // mechanism as challenges, but claimed-once-PER-DAY (reset next day with a new pool).
  dailyQuests: Array<{ id: string; title: string; goal: number; progress: number; done: boolean; claimed: boolean; rewardXp: number }>;
  // Rotating WEEKLY quests (this ISO-week's pool; rotate at the week boundary). Bigger XP,
  // claimed-once-PER-WEEK.
  weeklyQuests: Array<{ id: string; title: string; goal: number; progress: number; done: boolean; claimed: boolean; rewardXp: number }>;
  // The single NEXT uncollected level-up milestone the player has already REACHED (claimable
  // now), or null if none is pending. Surfaces a "claim your level reward" affordance.
  levelReward: { level: number; cosmeticId: string | null; bonusXp: number } | null;
  // Achievements (§2.6 badges): each carries its earned flag + progress to its threshold.
  // Server-evaluated; `earned` items have already had their badge id added to `user.badges`.
  achievements: Array<{ id: string; title: string; desc: string; icon: string; goal: number; progress: number; earned: boolean }>;
  // `costXp` is set on XP-priced items (cost is then 0); money items carry cost > 0.
  shop: Array<{ id: string; name: string; type: CosmeticType; cost: number; costXp?: number; owned: boolean; featured: boolean }>;
  equipped: { cardBack: string | null; tableFelt: string | null };
  // Today's discounted cosmetic (null if none). priceCents is the ENFORCED deal price.
  // MONEY-only — XP items are never discounted (dailyDealId filters cost > 0).
  dailyDeal: { id: string; pct: number; priceCents: number } | null;
}

export class RewardsService {
  constructor(
    private readonly users: UserRepository,
    public readonly enabled: boolean,
    private readonly wallet: PurchaseWallet,
  ) {}

  private owns(u: User, c: Cosmetic): boolean {
    // Free/default = cost 0 AND not XP-priced (an XP item ALSO has cost 0 but must be
    // BOUGHT, so it is not implicitly owned).
    const isFreeDefault = c.cost === 0 && !isXpPriced(c);
    return isFreeDefault || u.cosmetics.includes(c.id);
  }

  /** Map this period's quest pool to display rows. Progress is PER-PERIOD: count metrics
   *  (gamesPlayed/wins) measure (current − baseline) so a fresh day/week starts at 0;
   *  streak/level are point-in-time. `claimKeyFor` builds the 'period:questId' claim key. */
  private questRows(u: User, quests: QuestDef[], baseline: PeriodAnchor, claimedKeys: string[], claimKeyFor: (id: string) => string) {
    return quests.map((q) => {
      const progress = Math.min(questPeriodProgress(u, q.metric, baseline), q.goal);
      return {
        id: q.id,
        title: q.title,
        goal: q.goal,
        progress,
        done: progress >= q.goal,
        claimed: claimedKeys.includes(claimKeyFor(q.id)),
        rewardXp: q.rewardXp,
      };
    });
  }

  /** Resolve BOTH per-period anchors for `now`, lazily refreshing (and persisting) any that
   *  rolled over into a new period — the new period's count progress then starts at 0. Returns
   *  the effective baselines to measure progress against. Called by status() AND the claim
   *  paths so a claim can't bypass the rollover (e.g. claiming right after midnight). */
  private async resolveAnchors(userId: string, u: User, now: number): Promise<{ daily: PeriodAnchor; weekly: PeriodAnchor }> {
    const dayKey = utcDayKey(now);
    const weekKey = isoWeekKey(now);
    const daily = effectiveAnchor(u, dayKey, u.dailyAnchor);
    const weekly = effectiveAnchor(u, weekKey, u.weeklyAnchor);
    // Persist only what actually changed (rolled over) — avoids a write on every read.
    const patch: { dailyAnchor?: PeriodAnchor; weeklyAnchor?: PeriodAnchor } = {};
    if (!u.dailyAnchor || u.dailyAnchor.period !== dayKey) patch.dailyAnchor = daily;
    if (!u.weeklyAnchor || u.weeklyAnchor.period !== weekKey) patch.weeklyAnchor = weekly;
    if (patch.dailyAnchor || patch.weeklyAnchor) await this.users.setRewards(userId, patch);
    return { daily, weekly };
  }

  /** The next REACHED-but-uncollected level milestone, or null. Walks milestone levels
   *  up to the player's current level and returns the lowest one not yet collected — so a
   *  player who jumped several milestones at once collects them one at a time, in order. */
  private pendingMilestone(u: User): { level: number; cosmeticId: string | null; bonusXp: number } | null {
    const curLevel = levelInfo(u.xp).level;
    for (let lvl = MILESTONE_STEP; lvl <= curLevel; lvl += MILESTONE_STEP) {
      if (u.collectedMilestones.includes(lvl)) continue;
      const m = milestoneFor(lvl);
      if (m) return { level: m.level, cosmeticId: m.cosmeticId ?? null, bonusXp: m.bonusXp };
    }
    return null;
  }

  async status(userId: string, now: number): Promise<RewardsStatus | null> {
    let u = await this.users.findById(userId);
    if (!u) return null;
    // Lazily GRANT any achievement whose stat threshold is now met (idempotent — only ids
    // not already held are appended). Badges are cosmetic, so a write hiccup must never break
    // the status read. Done BEFORE the anchors so the anchor refresh sees the latest `u`.
    const newly = newlyEarnedAchievements(u);
    if (newly.length > 0) {
      const updated = await this.users
        .setRewards(userId, { badges: [...u.badges, ...newly] })
        .catch(() => null);
      if (updated) u = updated;
    }
    // Lazily roll over + persist the per-period anchors so daily/weekly progress is measured
    // WITHIN the period (a fresh day/week reads 0 on count-based quests).
    const anchors = await this.resolveAnchors(userId, u, now);
    const today = dayIndex(now);
    const lastDay = u.lastDailyClaim != null ? dayIndex(u.lastDailyClaim) : -Infinity;
    const canClaim = today > lastDay;
    const nextStreak = lastDay === today - 1 ? u.dailyStreak + 1 : 1;
    return {
      enabled: this.enabled,
      xp: u.xp,
      level: levelInfo(u.xp).level,
      spendableXp: Math.max(0, u.xp - u.xpSpent),
      daily: { canClaim, streak: u.dailyStreak, rewardXp: dailyReward(canClaim ? nextStreak : u.dailyStreak) },
      challenges: CHALLENGES.map((c) => {
        const progress = Math.min(metricValue(u, c.metric), c.goal);
        return { id: c.id, title: c.title, goal: c.goal, progress, done: progress >= c.goal, claimed: u.claimedChallenges.includes(c.id), rewardXp: c.rewardXp };
      }),
      dailyQuests: this.questRows(u, dailyQuestsFor(now), anchors.daily, u.claimedDailies, (id) => dailyClaimKey(now, id)),
      weeklyQuests: this.questRows(u, weeklyQuestsFor(now), anchors.weekly, u.claimedWeeklies, (id) => weeklyClaimKey(now, id)),
      levelReward: this.pendingMilestone(u),
      achievements: ACHIEVEMENTS.map((a) => {
        const progress = Math.min(achievementValue(u, a.metric), a.threshold);
        return { id: a.id, title: a.title, desc: a.desc, icon: a.icon, goal: a.threshold, progress, earned: u.badges.includes(a.id) };
      }),
      shop: COSMETICS.map((c) => ({ id: c.id, name: c.name, type: c.type, cost: c.cost, ...(isXpPriced(c) ? { costXp: c.costXp } : {}), owned: this.owns(u, c), featured: !!c.featured })),
      equipped: { cardBack: u.cardBack, tableFelt: u.tableFelt },
      dailyDeal: (() => {
        const id = dailyDealId(now);
        const c = id ? COSMETICS.find((x) => x.id === id) : null;
        return c ? { id: c.id, pct: DEAL_PCT, priceCents: dealPriceCents(c.cost) } : null;
      })(),
    };
  }

  /** Claim today's daily reward (XP). Idempotent per UTC day. */
  async claimDaily(userId: string, now: number): Promise<{ rewardXp: number; streak: number } | null> {
    const u = await this.users.findById(userId);
    if (!u) return null;
    const today = dayIndex(now);
    const lastDay = u.lastDailyClaim != null ? dayIndex(u.lastDailyClaim) : -Infinity;
    if (today <= lastDay) return null; // already claimed today
    const streak = lastDay === today - 1 ? u.dailyStreak + 1 : 1;
    const rewardXp = dailyReward(streak);
    await this.users.addXp(userId, rewardXp);
    await this.users.setRewards(userId, { lastDailyClaim: now, dailyStreak: streak });
    return { rewardXp, streak };
  }

  /** Claim a completed challenge's XP. Idempotent (claimedChallenges). */
  async claimChallenge(userId: string, challengeId: string): Promise<{ rewardXp: number } | null> {
    const def = CHALLENGES.find((c) => c.id === challengeId);
    if (!def) return null;
    const u = await this.users.findById(userId);
    if (!u || u.claimedChallenges.includes(def.id)) return null;
    if (metricValue(u, def.metric) < def.goal) return null; // not completed
    await this.users.addXp(userId, def.rewardXp);
    await this.users.setRewards(userId, { claimedChallenges: [...u.claimedChallenges, def.id] });
    return { rewardXp: def.rewardXp };
  }

  /** Claim a completed DAILY quest's XP. The quest must be in TODAY's deterministic pool
   *  and met; idempotent per UTC day via the 'YYYY-MM-DD:id' claim key (next day it's
   *  fresh again with a new pool). */
  async claimDailyQuest(userId: string, questId: string, now: number): Promise<{ rewardXp: number } | null> {
    const def = dailyQuestsFor(now).find((q) => q.id === questId);
    if (!def) return null; // not one of today's quests
    const u = await this.users.findById(userId);
    if (!u) return null;
    const key = dailyClaimKey(now, def.id);
    if (u.claimedDailies.includes(key)) return null; // already claimed today
    // Per-period progress (count metrics measure today's delta from the anchor). Resolving
    // anchors here also rolls them over if the claim is the first interaction of the day.
    const { daily } = await this.resolveAnchors(userId, u, now);
    if (questPeriodProgress(u, def.metric, daily) < def.goal) return null; // not completed today
    await this.users.addXp(userId, def.rewardXp);
    await this.users.setRewards(userId, { claimedDailies: [...u.claimedDailies, key] });
    return { rewardXp: def.rewardXp };
  }

  /** Claim a completed WEEKLY quest's XP. Must be in THIS ISO-week's pool and met;
   *  idempotent per week via the 'YYYY-Www:id' claim key. */
  async claimWeeklyQuest(userId: string, questId: string, now: number): Promise<{ rewardXp: number } | null> {
    const def = weeklyQuestsFor(now).find((q) => q.id === questId);
    if (!def) return null; // not one of this week's quests
    const u = await this.users.findById(userId);
    if (!u) return null;
    const key = weeklyClaimKey(now, def.id);
    if (u.claimedWeeklies.includes(key)) return null; // already claimed this week
    // Per-period progress (count metrics measure this week's delta from the anchor).
    const { weekly } = await this.resolveAnchors(userId, u, now);
    if (questPeriodProgress(u, def.metric, weekly) < def.goal) return null; // not completed this week
    await this.users.addXp(userId, def.rewardXp);
    await this.users.setRewards(userId, { claimedWeeklies: [...u.claimedWeeklies, key] });
    return { rewardXp: def.rewardXp };
  }

  /** Collect the next REACHED level-up milestone (idempotent via collectedMilestones).
   *  Grants the milestone's bonus XP + a free cosmetic (added to owned), then records the
   *  milestone so it can never be collected twice. Returns the granted reward, or null if
   *  nothing is pending. Collects ONE milestone per call (the lowest uncollected one). */
  async claimLevelReward(userId: string): Promise<{ level: number; cosmeticId: string | null; bonusXp: number } | null> {
    const u = await this.users.findById(userId);
    if (!u) return null;
    const pending = this.pendingMilestone(u);
    if (!pending) return null;
    // Mark collected FIRST (idempotency guard): re-reading + re-checking avoids a
    // double-grant if two requests race — the second sees it already collected.
    const fresh = await this.users.findById(userId);
    if (!fresh || fresh.collectedMilestones.includes(pending.level)) return null;
    await this.users.setRewards(userId, { collectedMilestones: [...fresh.collectedMilestones, pending.level] });
    if (pending.bonusXp > 0) await this.users.addXp(userId, pending.bonusXp);
    // Grant the free cosmetic (cost 0 → no XP/money spent) if it isn't already owned and
    // the id is a real catalog item. A failed/duplicate grant is non-fatal — the XP + the
    // collected mark still stand (the player got the bonus XP either way).
    if (pending.cosmeticId && COSMETICS.some((c) => c.id === pending.cosmeticId) && !fresh.cosmetics.includes(pending.cosmeticId)) {
      await this.users.purchaseCosmetic(userId, pending.cosmeticId, 0).catch(() => undefined);
    }
    return pending;
  }

  /** Buy a cosmetic with the wallet balance (real money). Debits the ledger, then
   *  grants the cosmetic. Cosmetics are non-refundable owned flags. */
  async buy(userId: string, cosmeticId: string, now: number = Date.now()): Promise<{ ok: boolean; code?: string }> {
    const c = COSMETICS.find((x) => x.id === cosmeticId);
    if (!c) return { ok: false, code: 'not_found' };
    // An XP-priced item must go through buyXp() — never charge the wallet for it.
    if (isXpPriced(c)) return { ok: false, code: 'wrong_currency' };
    if (c.cost === 0) return { ok: false, code: 'owned' }; // free/default — always owned
    const u = await this.users.findById(userId);
    if (!u) return { ok: false, code: 'not_found' };
    if (u.cosmetics.includes(cosmeticId)) return { ok: false, code: 'owned' };
    // The PRICE is computed server-side: today's daily-deal item gets the discount, never
    // trusted from the client. Charge the wallet first (money is the critical step).
    const charge = cosmeticId === dailyDealId(now) ? dealPriceCents(c.cost) : c.cost;
    try {
      await this.wallet.debit(userId, charge, { type: 'purchase', reason: `cosmetic:${cosmeticId}` });
    } catch (e) {
      if (e instanceof InsufficientFundsError) return { ok: false, code: 'insufficient_funds' };
      throw e;
    }
    // Grant the cosmetic (cost 0 → no XP spent, just the ownership flag). If the
    // grant THROWS or is REJECTED (e.g. a concurrent buy already granted it), REFUND
    // the charge — a player must never be debited for a cosmetic they didn't get.
    let granted: { ok: boolean; code?: string };
    try {
      granted = await this.users.purchaseCosmetic(userId, cosmeticId, 0);
    } catch (e) {
      await this.refundPurchase(userId, charge, cosmeticId);
      throw e;
    }
    if (!granted.ok) await this.refundPurchase(userId, charge, cosmeticId);
    return granted;
  }

  /** Best-effort compensating credit for a charge whose grant failed. */
  private async refundPurchase(userId: string, cents: number, cosmeticId: string): Promise<void> {
    await this.wallet.credit(userId, cents, { type: 'purchase', reason: `cosmetic-refund:${cosmeticId}` }).catch(() => undefined);
  }

  /** Buy an XP-priced cosmetic with SPENDABLE XP (xp - xpSpent). Mirrors buy() but NEVER
   *  touches the wallet — the grant + xpSpent increment is one atomic repo update, so there
   *  is nothing to refund. No daily-deal discount (XP items are full price). */
  async buyXp(userId: string, cosmeticId: string): Promise<{ ok: boolean; code?: string }> {
    const c = COSMETICS.find((x) => x.id === cosmeticId);
    if (!c) return { ok: false, code: 'not_found' };
    // A money item must go through buy() — refuse to "spend" XP on it.
    if (!isXpPriced(c)) return { ok: false, code: 'wrong_currency' };
    const u = await this.users.findById(userId);
    if (!u) return { ok: false, code: 'not_found' };
    if (u.cosmetics.includes(cosmeticId)) return { ok: false, code: 'owned' };
    // Atomic: deduct spendable XP (xpSpent += costXp) AND grant, or reject if short.
    return this.users.purchaseCosmeticXp(userId, cosmeticId, c.costXp!);
  }

  /** Equip an owned cosmetic into its slot. */
  async equip(userId: string, cosmeticId: string): Promise<{ ok: boolean; code?: string }> {
    const c = COSMETICS.find((x) => x.id === cosmeticId);
    if (!c) return { ok: false, code: 'not_found' };
    const u = await this.users.findById(userId);
    if (!u) return { ok: false, code: 'not_found' };
    if (!this.owns(u, c)) return { ok: false, code: 'not_owned' };
    await this.users.setRewards(userId, c.type === 'cardBack' ? { cardBack: c.id } : { tableFelt: c.id });
    return { ok: true };
  }
}
