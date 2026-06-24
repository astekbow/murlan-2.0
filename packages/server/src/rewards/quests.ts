// ============================================================================
// MURLAN — Rotating quests (daily + weekly) & level-up milestones (§2.6)
// ----------------------------------------------------------------------------
// The retention core. PURE & deterministic so the client and server agree on
// "today's 3" without any shared state:
//   • Daily   — N quests picked from a pool, seeded by the UTC date (YYYY-MM-DD).
//               Everyone sees the SAME 3 today; they ROTATE at UTC midnight.
//   • Weekly  — N bigger quests picked from a pool, seeded by the ISO week
//               (e.g. 2026-W26). Rotate at the ISO week boundary.
//   • Levels  — at each milestone level (5,10,15,…) grant ONE-TIME rewards
//               (a free cosmetic + bonus XP), idempotent via collectedMilestones.
// XP only — never cashable, never touches the wallet. Quests reuse the same
// player stats the challenges use (gamesPlayed / wins / currentStreak / level).
// ============================================================================

import type { User } from '../auth/userRepository.ts';
import { levelInfo } from '../profile/level.ts';

export type QuestMetric = 'gamesPlayed' | 'wins' | 'level' | 'currentStreak';

export interface QuestDef {
  id: string;
  title: string;
  goal: number;
  metric: QuestMetric;
  rewardXp: number;
}

// How many quests of each kind are shown per period.
export const DAILY_COUNT = 3;
export const WEEKLY_COUNT = 3;

// ── Pools ───────────────────────────────────────────────────────────────────
// Daily: small, same-session-achievable goals; XP 30–80.
export const DAILY_POOL: QuestDef[] = [
  { id: 'd_play2', title: 'Luaj 2 lojëra sot', goal: 2, metric: 'gamesPlayed', rewardXp: 30 },
  { id: 'd_play4', title: 'Luaj 4 lojëra sot', goal: 4, metric: 'gamesPlayed', rewardXp: 45 },
  { id: 'd_play6', title: 'Luaj 6 lojëra sot', goal: 6, metric: 'gamesPlayed', rewardXp: 60 },
  { id: 'd_win1', title: 'Fito një lojë sot', goal: 1, metric: 'wins', rewardXp: 40 },
  { id: 'd_win2', title: 'Fito 2 lojëra sot', goal: 2, metric: 'wins', rewardXp: 55 },
  { id: 'd_win3', title: 'Fito 3 lojëra sot', goal: 3, metric: 'wins', rewardXp: 70 },
  { id: 'd_streak2', title: 'Bëj seri 2 fitoresh', goal: 2, metric: 'currentStreak', rewardXp: 50 },
  { id: 'd_streak3', title: 'Bëj seri 3 fitoresh', goal: 3, metric: 'currentStreak', rewardXp: 80 },
];

// Weekly: bigger goals; XP 150–400. (Uses lifetime/cumulative metrics — see note
// in the service: weeklies are "reach a milestone" style, claimable once per week.)
export const WEEKLY_POOL: QuestDef[] = [
  { id: 'w_play20', title: 'Luaj 20 lojëra këtë javë', goal: 20, metric: 'gamesPlayed', rewardXp: 150 },
  { id: 'w_play40', title: 'Luaj 40 lojëra këtë javë', goal: 40, metric: 'gamesPlayed', rewardXp: 250 },
  { id: 'w_win10', title: 'Fito 10 lojëra këtë javë', goal: 10, metric: 'wins', rewardXp: 200 },
  { id: 'w_win20', title: 'Fito 20 lojëra këtë javë', goal: 20, metric: 'wins', rewardXp: 350 },
  { id: 'w_streak5', title: 'Bëj seri 5 fitoresh', goal: 5, metric: 'currentStreak', rewardXp: 300 },
  { id: 'w_level', title: 'Ngjit edhe një nivel', goal: 1, metric: 'level', rewardXp: 400 },
];

// ── Level-up milestones ──────────────────────────────────────────────────────
// At each step (5, 10, 15, …) the player collects ONE-TIME rewards: a free
// cosmetic (sensible low/mid-tier ids from the COSMETICS catalog) + bonus XP.
// Idempotent via the user's collectedMilestones list.
export interface MilestoneDef {
  level: number;
  cosmeticId?: string; // granted free (added to owned cosmetics)
  bonusXp: number;     // added to lifetime xp
}

export const MILESTONE_STEP = 5;
// Curated cosmetic grants ramp from low → mid tier as you climb. Beyond the last
// listed milestone, higher levels grant bonus XP only (milestoneFor handles it).
export const MILESTONES: MilestoneDef[] = [
  { level: 5, cosmeticId: 'cb_ivory', bonusXp: 100 },
  { level: 10, cosmeticId: 'felt_charcoal', bonusXp: 150 },
  { level: 15, cosmeticId: 'cb_ocean', bonusXp: 200 },
  { level: 20, cosmeticId: 'felt_forest', bonusXp: 250 },
  { level: 25, cosmeticId: 'cb_emerald', bonusXp: 300 },
  { level: 30, cosmeticId: 'felt_sapphire', bonusXp: 400 },
];

/** The milestone definition for a given milestone level, or null if not a
 *  milestone. Levels past the last curated entry still reward bonus XP (scaled),
 *  so high-level players keep getting milestone rewards (no cosmetic). */
export function milestoneFor(level: number): MilestoneDef | null {
  if (level < MILESTONE_STEP || level % MILESTONE_STEP !== 0) return null;
  const curated = MILESTONES.find((m) => m.level === level);
  if (curated) return curated;
  // Past the curated table → XP-only milestone (bonus grows gently with level).
  return { level, bonusXp: 200 + level * 10 };
}

// ── Deterministic seeding ─────────────────────────────────────────────────────
/** FNV-1a string hash → uint32 seed. Stable across runtimes (no Math.random). */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — tiny, deterministic, good enough for picking quests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick `count` DISTINCT items from `pool`, seeded — a partial Fisher–Yates over a
 *  copy so the same seed always yields the same selection (and order). */
export function pickSeeded<T>(pool: readonly T[], count: number, seed: number): T[] {
  const arr = pool.slice();
  const rnd = mulberry32(seed);
  const n = Math.min(count, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (arr.length - i));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr.slice(0, n);
}

// ── Date keys (UTC) ───────────────────────────────────────────────────────────
/** UTC calendar day key: 'YYYY-MM-DD'. Resets at UTC midnight. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** ISO-8601 week key: 'YYYY-Www' (e.g. '2026-W26'). The ISO week-year can differ
 *  from the calendar year at the boundary, which is exactly what we want — the
 *  key changes precisely at the ISO week boundary. */
export function isoWeekKey(now: number): string {
  // Copy to a UTC date at midnight; shift to the Thursday of this ISO week.
  const d = new Date(now);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay(): 0=Sun..6=Sat → ISO day 1=Mon..7=Sun.
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay); // move to Thursday (defines the week-year)
  const weekYear = date.getUTCFullYear();
  const yearStart = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

// ── Selection helpers ─────────────────────────────────────────────────────────
/** Today's daily quests (deterministic per UTC day). */
export function dailyQuestsFor(now: number): QuestDef[] {
  return pickSeeded(DAILY_POOL, DAILY_COUNT, hashSeed(`daily:${utcDayKey(now)}`));
}

/** This week's weekly quests (deterministic per ISO week). */
export function weeklyQuestsFor(now: number): QuestDef[] {
  return pickSeeded(WEEKLY_POOL, WEEKLY_COUNT, hashSeed(`weekly:${isoWeekKey(now)}`));
}

/** Composite claim key so a quest is tracked per-period: 'YYYY-MM-DD:id'. */
export function dailyClaimKey(now: number, questId: string): string {
  return `${utcDayKey(now)}:${questId}`;
}
export function weeklyClaimKey(now: number, questId: string): string {
  return `${isoWeekKey(now)}:${questId}`;
}

/** Read a quest metric off the user (level is derived from xp). */
export function questMetricValue(u: User, m: QuestMetric): number {
  if (m === 'level') return levelInfo(u.xp).level;
  return u[m];
}
