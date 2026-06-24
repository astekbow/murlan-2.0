import { test, expect, beforeEach } from 'vitest';
import { useSessionStore, elapsedMinutes, formatSessionDuration } from './sessionStore.ts';

beforeEach(() => useSessionStore.getState().clear());

test('start stamps a start time once and is idempotent', () => {
  expect(useSessionStore.getState().startedAt).toBeNull();
  useSessionStore.getState().start();
  const first = useSessionStore.getState().startedAt;
  expect(first).not.toBeNull();
  useSessionStore.getState().start(); // re-call must not reset the clock
  expect(useSessionStore.getState().startedAt).toBe(first);
});

test('clear resets the clock (logout)', () => {
  useSessionStore.getState().start();
  useSessionStore.getState().clear();
  expect(useSessionStore.getState().startedAt).toBeNull();
});

test('elapsedMinutes floors to whole minutes and never goes negative', () => {
  const now = 10_000_000;
  expect(elapsedMinutes(null, now)).toBe(0);
  expect(elapsedMinutes(now, now)).toBe(0);
  expect(elapsedMinutes(now - 90_000, now)).toBe(1); // 90s → 1m
  expect(elapsedMinutes(now - 3_600_000, now)).toBe(60);
  expect(elapsedMinutes(now + 5_000, now)).toBe(0); // clock skew → clamp to 0
});

test('formatSessionDuration is compact under an hour and Hh Mm beyond', () => {
  expect(formatSessionDuration(0)).toBe('0m');
  expect(formatSessionDuration(42)).toBe('42m');
  expect(formatSessionDuration(60)).toBe('1h 0m');
  expect(formatSessionDuration(65)).toBe('1h 5m');
  expect(formatSessionDuration(125)).toBe('2h 5m');
});
