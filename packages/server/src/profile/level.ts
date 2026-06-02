// Pure XP→level curve. Level is DERIVED from XP (never stored), so ordering a
// leaderboard by xp is identical to ordering by level. XP is cosmetic
// progression only — it is never cashable and has no bearing on money.

export interface LevelInfo {
  level: number;
  intoLevel: number;   // xp earned within the current level
  levelSpan: number;   // xp needed to span the current level
  pct: number;         // 0..1 progress to next level
}

const BASE = 100; // xp scale

export function levelInfo(xp: number): LevelInfo {
  const safe = Math.max(0, Math.floor(xp));
  const level = Math.floor(Math.sqrt(safe / BASE)) + 1;
  const curBase = BASE * (level - 1) ** 2;
  const nextBase = BASE * level ** 2;
  const levelSpan = nextBase - curBase;
  const intoLevel = safe - curBase;
  return { level, intoLevel, levelSpan, pct: levelSpan > 0 ? intoLevel / levelSpan : 0 };
}

// XP awarded per match (cosmetic only).
export const XP_PLAY = 20;
export const XP_WIN = 50;
