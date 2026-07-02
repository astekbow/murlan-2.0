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
      // Closed by ✕/backdrop/Escape (not Back) → pop our sentinel to keep history clean — but ONLY
      // while it is still the TOP entry. If something pushed after us, a blind back() pops THAT
      // entry and fires a phantom Back at its consumer. Concretely: the Create-Room modal closes
      // BECAUSE the room was created, but by then the table's exit guard has armed and pushed its
      // own sentinel — popping it made the guard silently leave the just-created room ("the room
      // closes within a second", 2026-07-03). An orphaned modal sentinel costs at most one absorbed
      // Back press later; popping someone else's entry costs a live room.
      if (!closedByBack && window.history.state?.__modal === true) window.history.back();
    };
  }, [open]);
}
