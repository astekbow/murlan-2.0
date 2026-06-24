import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyQuestsFor, weeklyQuestsFor, DAILY_COUNT, WEEKLY_COUNT,
  DAILY_POOL, WEEKLY_POOL, utcDayKey, isoWeekKey,
  milestoneFor, MILESTONE_STEP, pickSeeded,
} from './quests.ts';

// Fixed UTC instants for deterministic assertions.
const MON_2026_06_22 = Date.UTC(2026, 5, 22, 12, 0, 0); // Mon (ISO 2026-W26)
const TUE_2026_06_23 = Date.UTC(2026, 5, 23, 12, 0, 0); // next day, same ISO week
const SUN_2026_06_28 = Date.UTC(2026, 5, 28, 23, 59, 0); // Sun, still ISO 2026-W26
const MON_2026_06_29 = Date.UTC(2026, 5, 29, 0, 0, 0);   // next ISO week (2026-W27)

test('daily pool is DETERMINISTIC for the same UTC day (everyone sees the same 3)', () => {
  const a = dailyQuestsFor(MON_2026_06_22).map((q) => q.id);
  // Different instant, SAME UTC day → identical selection + order.
  const b = dailyQuestsFor(MON_2026_06_22 + 3_600_000).map((q) => q.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, DAILY_COUNT);
  assert.equal(new Set(a).size, DAILY_COUNT, 'picks are distinct');
  for (const id of a) assert.ok(DAILY_POOL.some((q) => q.id === id), 'picked from the pool');
});

test('daily pool ROTATES the next UTC day (changes tomorrow)', () => {
  const today = dailyQuestsFor(MON_2026_06_22).map((q) => q.id);
  const tomorrow = dailyQuestsFor(TUE_2026_06_23).map((q) => q.id);
  assert.notDeepEqual(today, tomorrow, 'a new day yields a rotated pool/order');
});

test('weekly pool is DETERMINISTIC within an ISO week and rotates across weeks', () => {
  const monday = weeklyQuestsFor(MON_2026_06_22).map((q) => q.id);
  const sunday = weeklyQuestsFor(SUN_2026_06_28).map((q) => q.id);
  assert.deepEqual(monday, sunday, 'same ISO week → same selection (Mon..Sun)');
  assert.equal(monday.length, WEEKLY_COUNT);
  for (const id of monday) assert.ok(WEEKLY_POOL.some((q) => q.id === id));

  const nextWeek = weeklyQuestsFor(MON_2026_06_29).map((q) => q.id);
  assert.notDeepEqual(monday, nextWeek, 'crossing the ISO week boundary rotates the pool');
});

test('utcDayKey / isoWeekKey produce the expected stable keys', () => {
  assert.equal(utcDayKey(MON_2026_06_22), '2026-06-22');
  assert.equal(isoWeekKey(MON_2026_06_22), '2026-W26');
  assert.equal(isoWeekKey(SUN_2026_06_28), '2026-W26');
  assert.equal(isoWeekKey(MON_2026_06_29), '2026-W27');
});

test('pickSeeded never exceeds the pool and is reproducible for a seed', () => {
  assert.deepEqual(pickSeeded([1, 2, 3], 5, 42), pickSeeded([1, 2, 3], 5, 42));
  assert.equal(pickSeeded([1, 2, 3], 5, 42).length, 3, 'clamped to pool size');
});

test('milestoneFor: only multiples of the step ≥ step are milestones', () => {
  assert.equal(milestoneFor(1), null);
  assert.equal(milestoneFor(4), null);
  assert.equal(milestoneFor(MILESTONE_STEP)?.level, MILESTONE_STEP);
  assert.equal(milestoneFor(10)?.level, 10);
  assert.ok((milestoneFor(10)?.bonusXp ?? 0) > 0);
  // Past the curated table → XP-only milestone (no cosmetic, still rewards XP).
  const far = milestoneFor(100);
  assert.ok(far && far.bonusXp > 0 && far.cosmeticId === undefined);
});
