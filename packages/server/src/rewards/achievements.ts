// ============================================================================
// MURLAN — Achievements / Badges (§2.6)
// ----------------------------------------------------------------------------
// An achievement is a one-time milestone over a player's EXISTING cosmetic stats
// (gamesPlayed/wins/currentStreak/level/biggestPotCents). Hitting one grants a
// BADGE id, appended ONCE to `user.badges` (append-only — never removed, even if
// a streak later resets). Evaluation is pure + idempotent so it can run lazily in
// the rewards status() read (like the daily/challenge anchors) without a job.
//
// Season badges (granted on season archive in rankedService) live in the SAME
// `user.badges` array but are NOT listed here — they're dynamic per-season ids
// (`season_<n>_champion`, …), described by seasonBadgeMeta() for the client.
// All of this is cosmetic/status ONLY — never money, never MMR.
// ============================================================================

import type { User } from '../auth/userRepository.ts';
import { levelInfo } from '../profile/level.ts';

/** The stat a milestone reads. `level` is DERIVED from xp (levelInfo), the rest are raw. */
export type AchievementMetric = 'wins' | 'gamesPlayed' | 'currentStreak' | 'level' | 'biggestPotCents';

export interface Achievement {
  /** Stable badge id, persisted in `user.badges` once earned. */
  id: string;
  /** Albanian title (display) + EN, plus a short description. */
  title: string;
  titleEn: string;
  desc: string;
  descEn: string;
  /** Emoji shown as the badge icon. */
  icon: string;
  metric: AchievementMetric;
  /** Earned once the metric value reaches (≥) this threshold. */
  threshold: number;
}

// Ordered roughly easiest → most prestigious. Titles in natural colloquial Albanian.
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_win',   title: 'Fitorja e parë',  titleEn: 'First win',     desc: 'Fito lojën tënde të parë.',         descEn: 'Win your first game.',          icon: '🥇', metric: 'wins',            threshold: 1 },
  { id: 'wins_10',     title: '10 fitore',        titleEn: '10 wins',       desc: 'Mblidh 10 fitore.',                 descEn: 'Reach 10 wins.',                icon: '🏅', metric: 'wins',            threshold: 10 },
  { id: 'wins_100',    title: '100 fitore',       titleEn: '100 wins',      desc: 'Mblidh 100 fitore.',                descEn: 'Reach 100 wins.',               icon: '🏆', metric: 'wins',            threshold: 100 },
  { id: 'games_1000',  title: '1000 lojëra',      titleEn: '1000 games',    desc: 'Luaj 1000 lojëra.',                 descEn: 'Play 1000 games.',              icon: '🎴', metric: 'gamesPlayed',     threshold: 1000 },
  { id: 'streak_5',    title: 'Seri 5 fitore',    titleEn: '5-win streak',  desc: 'Fito 5 lojëra radhazi.',            descEn: 'Win 5 games in a row.',         icon: '🔥', metric: 'currentStreak',   threshold: 5 },
  { id: 'streak_10',   title: 'Seri 10 fitore',   titleEn: '10-win streak', desc: 'Fito 10 lojëra radhazi.',           descEn: 'Win 10 games in a row.',        icon: '⚡', metric: 'currentStreak',   threshold: 10 },
  { id: 'level_10',    title: 'Nivel 10',         titleEn: 'Level 10',      desc: 'Arri Nivelin 10.',                  descEn: 'Reach level 10.',               icon: '⭐', metric: 'level',           threshold: 10 },
  { id: 'level_25',    title: 'Nivel 25',         titleEn: 'Level 25',      desc: 'Arri Nivelin 25.',                  descEn: 'Reach level 25.',               icon: '🌟', metric: 'level',           threshold: 25 },
  { id: 'pot_100',     title: 'Pot i madh',       titleEn: 'Big pot',       desc: 'Fito një pot prej $100 ose më shumë.', descEn: 'Win a pot of $100 or more.', icon: '💰', metric: 'biggestPotCents', threshold: 10_000 },
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/** The current value of an achievement's metric for a user (level derived from xp). */
export function achievementValue(u: User, metric: AchievementMetric): number {
  if (metric === 'level') return levelInfo(u.xp).level;
  return u[metric];
}

/** True once the user's metric has reached the threshold. */
export function isAchievementMet(u: User, a: Achievement): boolean {
  return achievementValue(u, a.metric) >= a.threshold;
}

/**
 * Achievement badge ids the user has now MET but does not yet hold — the set to
 * append to `user.badges`. Pure: never mutates. Empty when nothing new is earned.
 */
export function newlyEarnedAchievements(u: User): string[] {
  const held = new Set(u.badges);
  return ACHIEVEMENTS.filter((a) => !held.has(a.id) && isAchievementMet(u, a)).map((a) => a.id);
}

/** Look up an achievement definition by badge id (undefined for season/unknown ids). */
export function achievementById(id: string): Achievement | undefined {
  return BY_ID.get(id);
}

// ── Season badges ───────────────────────────────────────────────────────────
// Granted on season archive (rankedService.createSeason). The id encodes the
// season number so each season's badges are distinct + permanent.

export type SeasonBadgeKind = 'finalist' | 'top3' | 'champion';

/** The badge id for a season placement, e.g. seasonBadgeId(3,'champion') = 'season_3_champion'. */
export function seasonBadgeId(seasonNumber: number, kind: SeasonBadgeKind): string {
  return `season_${seasonNumber}_${kind}`;
}

const SEASON_BADGE_RE = /^season_(\d+)_(finalist|top3|champion)$/;

/** Decode a season badge id back to its number + kind (null if it isn't one). */
export function parseSeasonBadge(id: string): { number: number; kind: SeasonBadgeKind } | null {
  const m = SEASON_BADGE_RE.exec(id);
  if (!m) return null;
  return { number: Number(m[1]), kind: m[2] as SeasonBadgeKind };
}
