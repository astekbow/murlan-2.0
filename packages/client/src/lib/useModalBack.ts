import { useEffect, useRef } from 'react';

// Count of currently-open modal-back sentinels. A sibling back-consumer (useExitGuard at the table)
// checks this so it can tell that a Back press is closing a MODAL and stand down — otherwise one
// press both closes the modal AND fires the leave-table prompt (mobile-1).
let openModalBackCount = 0;
export function hasOpenModalBack(): boolean {
  return openModalBackCount > 0;
}

/**
 * Make the hardware/browser BACK button (Android especially) DISMISS an open overlay instead of leaving the
 * page. While mounted, a history sentinel is pushed; pressing Back pops it → onClose. Closing by other means
 * (the ✕ / backdrop / Escape) consumes the sentinel so the history stack stays clean.
 *
 * Coordinates with useUrlSync: the sentinel keeps the SAME path, so useUrlSync's popstate handler just
 * re-adopts the unchanged view (a no-op) and routing is untouched. The callback is held in a ref so an
 * inline-arrow onClose (new identity each render) can't thrash the history stack.
 */
export function useModalBack(open: boolean, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!open) return;
    openModalBackCount += 1;
    let closedByBack = false;
    window.history.pushState({ __modal: true }, '');
    const onPop = () => { closedByBack = true; cb.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      openModalBackCount -= 1;
      window.removeEventListener('popstate', onPop);
      // Closed by ✕/backdrop/Escape (not Back) → pop our sentinel to keep history clean — but
      // DEFERRED and only while it is still the TOP entry. Two real-world races (2026-07-03):
      //  • The modal closes BECAUSE a room was created (Create-Room / Practice / quick-play):
      //    the table's exit guard arms around the same commit and pushes ITS sentinel. A blind
      //    synchronous back() here is QUEUED before that push yet EXECUTES after it (history
      //    traversal is async), so it ate the guard's entry and the guard read the resulting
      //    popstate as a real Back press → it silently left the just-created room.
      //  • A sibling modal can open in the same commit — popping would eat ITS sentinel.
      // Deferring one macrotask lets the stack settle; then we compensate ONLY if our own
      // sentinel is still on top and no other modal has taken over. An orphaned sentinel costs
      // at most one absorbed Back press later; popping someone else's entry costs a live room.
      if (!closedByBack) {
        setTimeout(() => {
          if (!hasOpenModalBack() && window.history.state?.__modal === true) window.history.back();
        }, 0);
      }
    };
  }, [open]);
}
