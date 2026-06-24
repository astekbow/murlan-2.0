import { test } from 'vitest';
import assert from 'node:assert/strict';
import { earnedBadges } from './badges.ts';
import type { Profile } from './api.ts';

const base: Profile = {
  id: 'u', username: 'x', avatar: null, xp: 0, level: 1,
  levelInfo: { level: 1, intoLevel: 0, levelSpan: 100, pct: 0 },
  gamesPlayed: 0, wins: 0, winRate: 0, biggestPotCents: 0, currentStreak: 0, vipTier: null,
};

test('a fresh profile has no badges', () => {
  assert.deepEqual(earnedBadges(base), []);
});

test('thresholds award the right badges', () => {
  const ids = (p: Partial<Profile>) => earnedBadges({ ...base, ...p }).map((b) => b.id);
  assert.deepEqual(ids({ level: 10 }), ['elite']);
  assert.deepEqual(ids({ wins: 50 }).sort(), ['master', 'winner']); // 50 wins ⇒ both win badges
  assert.ok(ids({ gamesPlayed: 100 }).includes('veteran'));
  assert.ok(ids({ biggestPotCents: 10_000 }).includes('bigpot'));
  assert.ok(ids({ currentStreak: 5 }).includes('streak'));
  assert.ok(ids({ gamesPlayed: 20, winRate: 0.6 }).includes('consistent'));
});

test('just-below thresholds award nothing', () => {
  assert.deepEqual(earnedBadges({ ...base, level: 9, wins: 9, gamesPlayed: 99, currentStreak: 4, biggestPotCents: 9_999 }), []);
});

test('badges are ordered most-prestigious first', () => {
  const ids = earnedBadges({ ...base, level: 10, wins: 50, gamesPlayed: 100 }).map((b) => b.id);
  assert.equal(ids[0], 'elite'); // 👑 leads
  assert.ok(ids.indexOf('master') < ids.indexOf('winner'));
});
