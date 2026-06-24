import { test, expect, beforeEach, vi } from 'vitest';

// hashTokens.ts captures the entry URL FRAGMENT at MODULE LOAD, so each case resets the
// module registry + the URL before (re)importing it. The fragment must be stripped
// SYNCHRONOUSLY on import (before any network call could leak it).
beforeEach(() => {
  vi.resetModules();
  window.history.replaceState({}, '', '/');
});

test('captures #resetPassword=<token> and strips the fragment synchronously on import', async () => {
  window.history.replaceState({}, '', '/#resetPassword=abc123def');
  const { getResetToken, takeVerifyToken } = await import('./hashTokens.ts');
  // The fragment is already gone by the time import resolves (sync strip at module load).
  expect(window.location.hash).toBe('');
  expect(getResetToken()).toBe('abc123def');
  expect(getResetToken()).toBe('abc123def'); // stable (the reset view needs it across renders)
  expect(takeVerifyToken()).toBe(null);
});

test('captures #verifyEmail=<token> once and strips the fragment', async () => {
  window.history.replaceState({}, '', '/#verifyEmail=tok999');
  const { takeVerifyToken, getResetToken } = await import('./hashTokens.ts');
  expect(window.location.hash).toBe('');
  expect(getResetToken()).toBe(null);
  expect(takeVerifyToken()).toBe('tok999');
  expect(takeVerifyToken()).toBe(null); // consumed once — a refresh won't re-verify
});

test('preserves the path + query string while stripping only the fragment', async () => {
  window.history.replaceState({}, '', '/wallet?replay=m1#resetPassword=secret');
  const { getResetToken } = await import('./hashTokens.ts');
  expect(getResetToken()).toBe('secret');
  expect(window.location.pathname).toBe('/wallet');
  expect(window.location.search).toBe('?replay=m1'); // ?replay= survives (not a token)
  expect(window.location.hash).toBe('');
});

test('no fragment → no tokens, URL untouched', async () => {
  window.history.replaceState({}, '', '/lobby');
  const { getResetToken, takeVerifyToken } = await import('./hashTokens.ts');
  expect(getResetToken()).toBe(null);
  expect(takeVerifyToken()).toBe(null);
  expect(window.location.pathname).toBe('/lobby');
});

test('a non-token fragment (e.g. an anchor) is left alone', async () => {
  window.history.replaceState({}, '', '/#section');
  const { getResetToken, takeVerifyToken } = await import('./hashTokens.ts');
  expect(getResetToken()).toBe(null);
  expect(takeVerifyToken()).toBe(null);
  expect(window.location.hash).toBe('#section'); // unrelated anchor preserved
});
