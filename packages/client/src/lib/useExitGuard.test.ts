// ============================================================================
// useExitGuard — the at-the-table Back trap.
// It must fire ONLY for a real user Back press: stand down when a modal owns
// the press, and stand down when the pop merely LANDED on one of its own
// sentinels (that means the popped entry sat ABOVE the trap — e.g. a modal's
// deferred compensating back() — not the user escaping). Reading that wrong
// silently left just-created rooms (2026-07-03).
// ============================================================================

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useExitGuard } from './useExitGuard.ts';
import { useModalBack } from './useModalBack.ts';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const pop = (state: unknown) => window.dispatchEvent(new PopStateEvent('popstate', { state }));

test('arming pushes an exitGuard sentinel', () => {
  const { unmount } = renderHook(() => useExitGuard(true, () => {}));
  expect(window.history.state?.exitGuard).toBe(true);
  unmount();
});

test('a real Back press re-traps and notifies', () => {
  const push = vi.spyOn(window.history, 'pushState');
  const onBack = vi.fn();
  const { unmount } = renderHook(() => useExitGuard(true, onBack));
  push.mockClear();
  pop(null); // the user's Back consumed the sentinel — landing state is the base entry
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenCalledTimes(1); // re-trapped for the next press
  unmount();
});

test('REGRESSION: a pop that lands ON an exitGuard sentinel is ignored (trap intact)', () => {
  const onBack = vi.fn();
  const { unmount } = renderHook(() => useExitGuard(true, onBack));
  // e.g. a modal's deferred compensating back() popped an entry pushed ABOVE the trap:
  // the landing state is the guard's own sentinel — NOT a user escape.
  pop({ exitGuard: true });
  expect(onBack).not.toHaveBeenCalled();
  unmount();
});

test('stands down while a modal owns the Back press', () => {
  const onBack = vi.fn();
  const guard = renderHook(() => useExitGuard(true, onBack));
  const modal = renderHook(() => useModalBack(true, () => {})); // a modal is open on top
  pop(null); // this Back is closing the modal
  expect(onBack).not.toHaveBeenCalled();
  modal.unmount();
  guard.unmount();
});

test('inactive guard never traps or fires', () => {
  const push = vi.spyOn(window.history, 'pushState');
  const onBack = vi.fn();
  const { unmount } = renderHook(() => useExitGuard(false, onBack));
  expect(push).not.toHaveBeenCalled();
  pop(null);
  expect(onBack).not.toHaveBeenCalled();
  unmount();
});
