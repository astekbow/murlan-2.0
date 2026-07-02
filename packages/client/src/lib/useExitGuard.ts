import { useEffect, useRef } from 'react';
import { hasOpenModalBack } from './useModalBack.ts';

/**
 * While `active` (the player is in a room / at the table), ABSORB the browser/Android
 * hardware **back** gesture so it can never (a) exit a standalone PWA mid-match or
 * (b) silently abandon a staked table. Each back press is re-trapped with a fresh history
 * entry and `onBack` fires instead — App turns that into a "leave the table?" prompt, so
 * the explicit Leave button (with its stake-forfeit warning) stays the only real exit.
 *
 * `onBack` is read through a ref so the effect only re-arms when `active` flips, not on
 * every render (otherwise an inline callback would push a new trap entry each render).
 */
export function useExitGuard(active: boolean, onBack: () => void): void {
  const cb = useRef(onBack);
  cb.current = onBack;

  useEffect(() => {
    if (!active) return;
    // Seed one sentinel entry so the FIRST back press has something to consume.
    window.history.pushState({ exitGuard: true }, '', window.location.href);
    const onPop = (e: PopStateEvent) => {
      // mobile-1: if a modal is open, THIS Back press is closing the modal (useModalBack owns it).
      // Stand down — don't also re-trap + fire the leave-table prompt (the double-consumer bug that
      // bounced players out of a live game on Android). Our own sentinel is still on the stack, so
      // the NEXT back (with no modal open) re-arms the guard normally.
      if (hasOpenModalBack()) return;
      // Landing ON one of our own sentinels means the popped entry sat ABOVE the trap — that's
      // someone else's history hygiene (e.g. a modal's deferred compensating back()), NOT the
      // user escaping. The trap is intact; stand down instead of firing a phantom leave prompt
      // (or, in a waiting room, a silent leave — the "room closes within a second" bug).
      if ((e.state as { exitGuard?: boolean } | null)?.exitGuard === true) return;
      // Still in the room when back fired → re-trap (never let it exit) + notify App.
      window.history.pushState({ exitGuard: true }, '', window.location.href);
      cb.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [active]);
}
