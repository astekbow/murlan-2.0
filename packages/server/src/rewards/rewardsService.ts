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
  cost: number; // PRICE IN CENTS (wallet money); 0 = free/default (always owned)
}

export const COSMETICS: Cosmetic[] = [
  // Card backs
  { id: 'cb_classic', name: 'Pas klasik', type: 'cardBack', cost: 0 },
  { id: 'cb_gold', name: 'Pas ari', type: 'cardBack', cost: 300 },
  { id: 'cb_emerald', name: 'Pas smerald', type: 'cardBack', cost: 350 },
  { id: 'cb_sapphire', name: 'Pas safir', type: 'cardBack', cost: 350 },
  { id: 'cb_rose', name: 'Pas trëndafili', type: 'cardBack', cost: 450 },
  { id: 'cb_carbon', name: 'Pas karboni', type: 'cardBack', cost: 500 },
  { id: 'cb_royal', name: 'Pas mbretëror', type: 'cardBack', cost: 600 },
  // Table felts
  { id: 'felt_red', name: 'Çoha e kuqe', type: 'tableFelt', cost: 0 },
  { id: 'felt_emerald', name: 'Çoha smerald', type: 'tableFelt', cost: 400 },
  { id: 'felt_sapphire', name: 'Çoha safir', type: 'tableFelt', cost: 400 },
  { id: 'felt_wine', name: 'Çoha verë', type: 'tableFelt', cost: 450 },
  { id: 'felt_obsidian', name: 'Çoha obsidian', type: 'tableFelt', cost: 600 },
  { id: 'felt_midnight', name: 'Çoha mesnatë', type: 'tableFelt', cost: 700 },
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
  daily: { canClaim: boolean; streak: number; rewardXp: number };
  challenges: Array<{ id: string; title: string; goal: number; progress: number; done: boolean; claimed: boolean; rewardXp: number }>;
  shop: Array<{ id: string; name: string; type: CosmeticType; cost: number; owned: boolean }>;
  equipped: { cardBack: string | null; tableFelt: string | null };
}

export class RewardsService {
  constructor(
    private readonly users: UserRepository,
    public readonly enabled: boolean,
    private readonly wallet: PurchaseWallet,
  ) {}

  private owns(u: User, c: Cosmetic): boolean {
    return c.cost === 0 || u.cosmetics.includes(c.id);
  }

  async status(userId: string, now: number): Promise<RewardsStatus | null> {
    const u = await this.users.findById(userId);
    if (!u) return null;
    const today = dayIndex(now);
    const lastDay = u.lastDailyClaim != null ? dayIndex(u.lastDailyClaim) : -Infinity;
    const canClaim = today > lastDay;
    const nextStreak = lastDay === today - 1 ? u.dailyStreak + 1 : 1;
    return {
      enabled: this.enabled,
      xp: u.xp,
      level: levelInfo(u.xp).level,
      daily: { canClaim, streak: u.dailyStreak, rewardXp: dailyReward(canClaim ? nextStreak : u.dailyStreak) },
      challenges: CHALLENGES.map((c) => {
        const progress = Math.min(metricValue(u, c.metric), c.goal);
        return { id: c.id, title: c.title, goal: c.goal, progress, done: progress >= c.goal, claimed: u.claimedChallenges.includes(c.id), rewardXp: c.rewardXp };
      }),
      shop: COSMETICS.map((c) => ({ id: c.id, name: c.name, type: c.type, cost: c.cost, owned: this.owns(u, c) })),
      equipped: { cardBack: u.cardBack, tableFelt: u.tableFelt },
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

  /** Buy a cosmetic with the wallet balance (real money). Debits the ledger, then
   *  grants the cosmetic. Cosmetics are non-refundable owned flags. */
  async buy(userId: string, cosmeticId: string): Promise<{ ok: boolean; code?: string }> {
    const c = COSMETICS.find((x) => x.id === cosmeticId);
    if (!c) return { ok: false, code: 'not_found' };
    if (c.cost === 0) return { ok: false, code: 'owned' }; // free/default — always owned
    const u = await this.users.findById(userId);
    if (!u) return { ok: false, code: 'not_found' };
    if (u.cosmetics.includes(cosmeticId)) return { ok: false, code: 'owned' };
    // Charge the wallet first (money is the critical step); insufficient → typed error.
    try {
      await this.wallet.debit(userId, c.cost, { type: 'purchase', reason: `cosmetic:${cosmeticId}` });
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
      await this.refundPurchase(userId, c.cost, cosmeticId);
      throw e;
    }
    if (!granted.ok) await this.refundPurchase(userId, c.cost, cosmeticId);
    return granted;
  }

  /** Best-effort compensating credit for a charge whose grant failed. */
  private async refundPurchase(userId: string, cents: number, cosmeticId: string): Promise<void> {
    await this.wallet.credit(userId, cents, { type: 'purchase', reason: `cosmetic-refund:${cosmeticId}` }).catch(() => undefined);
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
