import { test } from 'vitest';
import assert from 'node:assert/strict';
import { earnedBadges } from './badges.ts';
import type { Profile } from './api.ts';

const base: Profile = {
  id: 'u', username: 'x', avatar: null, xp: 0, level: 1,
  levelInfo: { level: 1, intoLevel: 0, levelSpan: 100, pct: 0 },
  gamesPlayed: 0, wins: 0, winRate: 0, biggestPotCents: 0, currentStreak: 0, vipTier: null,
  badges: [],
};

test('a profile with no server badges shows nothing', () => {
  assert.deepEqual(earnedBadges(base), []);
});

test('server badge ids resolve to display metadata (icon + label)', () => {
  const badges = earnedBadges({ ...base, badges: ['first_win'] });
  assert.equal(badges.length, 1);
  assert.equal(badges[0]!.id, 'first_win');
  assert.equal(badges[0]!.icon, '🥇');
  assert.ok(badges[0]!.name.length > 0);
});

test('unknown badge ids are dropped', () => {
  assert.deepEqual(earnedBadges({ ...base, badges: ['not_a_real_badge'] }), []);
});

test('season badge ids resolve with the season number interpolated', () => {
  const badges = earnedBadges({ ...base, badges: ['season_3_champion'] });
  assert.equal(badges.length, 1);
  assert.equal(badges[0]!.icon, '👑');
  assert.ok(badges[0]!.name.includes('3'), 'season number is shown');
});

test('achievements sort above season badges; more prestigious first', () => {
  const ids = earnedBadges({
    ...base,
    badges: ['season_1_finalist', 'first_win', 'wins_100', 'season_2_champion'],
  }).map((b) => b.id);
  // Achievements lead (wins_100 is more prestigious than first_win), then season badges.
  assert.ok(ids.indexOf('wins_100') < ids.indexOf('first_win'));
  assert.ok(ids.indexOf('first_win') < ids.indexOf('season_2_champion'));
  // Newer season (2) before older (1).
  assert.ok(ids.indexOf('season_2_champion') < ids.indexOf('season_1_finalist'));
});
