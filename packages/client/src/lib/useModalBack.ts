import { useEffect, useRef } from 'react';

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
    let closedByBack = false;
    window.history.pushState({ __modal: true }, '');
    const onPop = () => { closedByBack = true; cb.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed by ✕/backdrop/Escape (not Back) → the sentinel is still on top; pop it to keep history clean.
      if (!closedByBack) window.history.back();
    };
  }, [open]);
}
