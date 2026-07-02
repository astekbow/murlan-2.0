// ============================================================================
// useModalBack — history-sentinel hygiene.
// The regression class that mattered (2026-07-03): a modal that closes
// PROGRAMMATICALLY compensated with history.back(). But the modal often closes
// precisely BECAUSE a room was created (Create-Room / Practice / quick-play) —
// the table's exit guard arms around the same commit and pushes ITS sentinel,
// and history traversal is ASYNC, so the blind back() ate the guard's entry;
// the guard read the popstate as a real Back press and silently left the
// just-created room ("the room closes within a second"). The fix: DEFER the
// compensation one macrotask and only back() while our own sentinel is still
// the top entry and no sibling modal has taken over.
// ============================================================================

import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useModalBack, hasOpenModalBack } from './useModalBack.ts';

beforeEach(() => {
  // Neutral top-of-stack entry so tests don't leak history state into each other.
  window.history.replaceState(null, '', '/');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('open pushes a modal sentinel and registers as the open modal', () => {
  const { unmount } = renderHook(() => useModalBack(true, () => {}));
  expect(window.history.state?.__modal).toBe(true);
  expect(hasOpenModalBack()).toBe(true);
  unmount();
  expect(hasOpenModalBack()).toBe(false);
});

test('programmatic close pops its OWN sentinel (deferred) when it is still on top', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const { unmount } = renderHook(() => useModalBack(true, () => {}));
  unmount(); // closed via ✕/backdrop/Escape — compensation is deferred one macrotask
  expect(back).not.toHaveBeenCalled(); // not synchronously (that was the race)
  vi.runAllTimers();
  expect(back).toHaveBeenCalledTimes(1); // sentinel still on top → clean it up
});

test('REGRESSION (create-room ordering): a foreign entry pushed BEFORE close is not popped', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const { unmount } = renderHook(() => useModalBack(true, () => {}));
  // The exit guard armed first (room already created) and pushed ITS sentinel on top.
  window.history.pushState({ exitGuard: true }, '', window.location.href);
  unmount();
  vi.runAllTimers();
  expect(back).not.toHaveBeenCalled();
  expect(window.history.state?.exitGuard).toBe(true); // the guard's trap is intact
});

test('REGRESSION (practice ordering): a foreign entry pushed right AFTER close is not popped', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const { unmount } = renderHook(() => useModalBack(true, () => {}));
  unmount(); // cleanup runs FIRST (same React commit)...
  // ...and the exit guard's effect pushes its sentinel right after, before the timer fires.
  window.history.pushState({ exitGuard: true }, '', window.location.href);
  vi.runAllTimers();
  expect(back).not.toHaveBeenCalled(); // deferred check sees the guard on top → stands down
  expect(window.history.state?.exitGuard).toBe(true);
});

test('closing one modal while a sibling modal is open does not pop the sibling sentinel', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const a = renderHook(() => useModalBack(true, () => {}));
  const b = renderHook(() => useModalBack(true, () => {}));
  a.unmount();
  vi.runAllTimers();
  expect(back).not.toHaveBeenCalled(); // b is still open — its sentinel must survive
  b.unmount();
  vi.runAllTimers();
  expect(back).toHaveBeenCalledTimes(1); // now the (single remaining) sentinel is cleaned
});

test('close via the Back button does not double-pop (no compensating back())', () => {
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const onClose = vi.fn();
  const { unmount } = renderHook(() => useModalBack(true, onClose));
  window.dispatchEvent(new PopStateEvent('popstate')); // user pressed Back → closes the modal
  expect(onClose).toHaveBeenCalledTimes(1);
  unmount();
  vi.runAllTimers();
  expect(back).not.toHaveBeenCalled(); // Back already consumed the sentinel
});
