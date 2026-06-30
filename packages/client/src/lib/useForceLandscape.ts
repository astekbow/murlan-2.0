import { useEffect, useState } from 'react';

interface LandscapeState {
  /** The phone is physically in landscape → use the wide landscape layout (.tv-ls). */
  ls: boolean;
  /** The phone is held in PORTRAIT → show the "rotate your phone" prompt over the game. */
  forced: boolean;
}

/** Drives the game table's landscape-only behaviour. On a phone the table always
 *  renders horizontally: real landscape uses the layout directly; portrait is
 *  rotated 90°. Also best-effort locks orientation to landscape on Android (iOS has
 *  no lock API, so the CSS rotation handles it). Desktops/large tablets: no-op. */
export function useForceLandscape(): LandscapeState {
  const [state, setState] = useState<LandscapeState>({ ls: false, forced: false });

  useEffect(() => {
    const orientation = screen.orientation as
      | (ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void })
      | undefined;
    try { void orientation?.lock?.('landscape')?.catch(() => {}); } catch { /* unsupported (iOS) */ }

    // Use the wide table layout for ANY landscape TOUCH device (phones AND iPads/large phones/foldables),
    // not just short phones — the old `max-height:560px` ceiling dropped iPads + big phones to the legacy
    // portrait flow. The `pointer: coarse` clause keeps DESKTOP (fine pointer) on its own layout untouched;
    // the max-height:560 clause still catches a short landscape phone even if it doesn't report coarse.
    const realLandscape = window.matchMedia('(orientation: landscape) and (max-height: 560px), (orientation: landscape) and (pointer: coarse)');
    // Portrait phone → force-rotate. NOTE: no `(pointer: coarse)` clause — some phones
    // and device emulators don't report it, which silently disabled the rotation.
    const phonePortrait = window.matchMedia('(orientation: portrait) and (max-width: 932px)');
    const update = () => setState({ ls: realLandscape.matches, forced: phonePortrait.matches });
    update();
    realLandscape.addEventListener('change', update);
    phonePortrait.addEventListener('change', update);
    return () => {
      realLandscape.removeEventListener('change', update);
      phonePortrait.removeEventListener('change', update);
      try { orientation?.unlock?.(); } catch { /* noop */ }
    };
  }, []);

  return state;
}
