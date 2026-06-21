import { test, expect, beforeEach, vi } from 'vitest';

// deepLink.ts captures the entry URL at MODULE LOAD, so each case resets the module
// registry + the URL before (re)importing it.
beforeEach(() => {
  vi.resetModules();
  window.history.replaceState({}, '', '/');
});

test('roomInviteLink builds an absolute /join/<code> URL', async () => {
  const { roomInviteLink } = await import('./deepLink.ts');
  expect(roomInviteLink('123456')).toBe(`${window.location.origin}/join/123456`);
});

test('captures a /join/<code> invite exactly once and cleans the URL', async () => {
  window.history.replaceState({}, '', '/join/654321');
  const { takePendingJoinCode } = await import('./deepLink.ts');
  expect(takePendingJoinCode()).toBe('654321');
  expect(takePendingJoinCode()).toBe(null);     // consumed once — a refresh won't re-join
  expect(window.location.pathname).toBe('/');    // URL cleaned
});

test('captures a /u/<id> profile link once and cleans the URL', async () => {
  window.history.replaceState({}, '', '/u/usr_abc123');
  const { takePendingProfileId, takePendingJoinCode } = await import('./deepLink.ts');
  expect(takePendingJoinCode()).toBe(null);
  expect(takePendingProfileId()).toBe('usr_abc123');
  expect(takePendingProfileId()).toBe(null); // consumed once
  expect(window.location.pathname).toBe('/');
});

test('rewrites /t/<id> to /tournaments with no pending join', async () => {
  window.history.replaceState({}, '', '/t/abc123');
  const { takePendingJoinCode } = await import('./deepLink.ts');
  expect(takePendingJoinCode()).toBe(null);
  expect(window.location.pathname).toBe('/tournaments');
});

test('leaves a normal lobby path untouched', async () => {
  window.history.replaceState({}, '', '/wallet');
  const { takePendingJoinCode } = await import('./deepLink.ts');
  expect(takePendingJoinCode()).toBe(null);
  expect(window.location.pathname).toBe('/wallet');
});

test('ignores a malformed join code (too short / illegal chars)', async () => {
  window.history.replaceState({}, '', '/join/!!');
  const { takePendingJoinCode } = await import('./deepLink.ts');
  expect(takePendingJoinCode()).toBe(null);
});
