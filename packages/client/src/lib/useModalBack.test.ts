// ============================================================================
// useModalBack — history-sentinel hygiene.
// The regression that mattered (2026-07-03): a modal that closes PROGRAMMATICALLY
// (not via Back) used to call history.back() blindly. When another consumer had
// already pushed on top — the table's exit guard arms the moment a room opens,
// and the Create-Room modal closes precisely BECAUSE the room was created — that
// back() popped the GUARD's sentinel, the guard read it as a real Back press, and
// silently left the just-created room ("the room closes within a second").
// The fix: compensate with back() ONLY while our own sentinel is still on top.
// ============================================================================

import { test, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useModalBack, hasOpenModalBack } from './useModalBack.ts';

beforeEach(() => {
  // Reset to a neutral top-of-stack entry so tests don't leak state into each other.
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

test('open pushes a modal sentinel and registers as the open modal', () => {
  const { unmount } = renderHook(() => useModalBack(true, () => {}));
  expect(window.history.state?.__modal).toBe(true);
  expect(hasOpenModalBack()).toBe(true);
  unmount();
  expect(hasOpenModalBack()).toBe(false);
});

test('programmatic close pops its OWN sentinel when it is still on top', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const { unmount } = renderHook(() => useModalBack(true, () => {}));
  expect(window.history.state?.__modal).toBe(true);
  unmount(); // closed via ✕/backdrop/Escape — sentinel still on top → clean it up
  expect(back).toHaveBeenCalledTimes(1);
});

test('REGRESSION: programmatic close must NOT pop a foreign entry pushed after it', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const { unmount } = renderHook(() => useModalBack(true, () => {}));
  // The exit guard arms (a room was just created) and pushes ITS sentinel on top.
  window.history.pushState({ exitGuard: true }, '', window.location.href);
  unmount(); // modal closes because the room was created
  // A blind back() here would pop the guard's sentinel → phantom Back → the guard
  // silently leaves the just-created room. It must stand down instead.
  expect(back).not.toHaveBeenCalled();
  expect(window.history.state?.exitGuard).toBe(true); // the guard's trap is intact
});

test('close via the Back button does not double-pop (no compensating back())', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const onClose = vi.fn();
  const { unmount } = renderHook(() => useModalBack(true, onClose));
  window.dispatchEvent(new PopStateEvent('popstate')); // user pressed Back → closes the modal
  expect(onClose).toHaveBeenCalledTimes(1);
  unmount();
  expect(back).not.toHaveBeenCalled(); // Back already consumed the sentinel
});
