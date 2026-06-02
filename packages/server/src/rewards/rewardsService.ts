// ============================================================================
// MURLAN — Engagement rewards (Phase 6, §2.6)
// ----------------------------------------------------------------------------
// Daily login, challenges, and a cosmetic shop. STRICTLY XP + cosmetics — never
// touches the $ balance / ledger, so it cannot be a cashable bonus. Gated by the
// `enabled` flag (per-jurisdiction off switch). Challenges are computed from the
// player's existing stats; nothing here can affect money or the rules engine.
// ============================================================================

import type { UserRepository, User } from '../auth/userRepository.ts';
import { levelInfo } from '../profile/level.ts';

export type CosmeticType = 'cardBack' | 'tableFelt';
export interface Cosmetic {
  id: string;
  name: string;
  type: CosmeticType;
  cost: number; // XP cost; 0 = free/default (always owned)
}

export const COSMETICS: Cosmetic[] = [
  { id: 'cb_classic', name: 'Pas klasik', type: 'cardBack', cost: 0 },
  { id: 'cb_gold', name: 'Pas ari', type: 'cardBack', cost: 300 },
  { id: 'cb_royal', name: 'Pas mbretëror', type: 'cardBack', cost: 600 },
  { id: 'felt_red', name: 'Çoha e kuqe', type: 'tableFelt', cost: 0 },
  { id: 'felt_emerald', name: 'Çoha smerald', type: 'tableFelt', cost: 400 },
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
  constructor(private readonly users: UserRepository, public readonly enabled: boolean) {}

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

  /** Buy a cosmetic with XP (never $). Atomic: the deduct + grant happen in one
   *  operation, so concurrent buys can't double-spend XP or duplicate the grant. */
  async buy(userId: string, cosmeticId: string): Promise<{ ok: boolean; code?: string }> {
    const c = COSMETICS.find((x) => x.id === cosmeticId);
    if (!c) return { ok: false, code: 'not_found' };
    if (c.cost === 0) return { ok: false, code: 'owned' }; // free/default — always owned
    return this.users.purchaseCosmetic(userId, cosmeticId, c.cost);
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
