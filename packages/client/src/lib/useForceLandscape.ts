import { useEffect, useState } from 'react';

interface LandscapeState {
  /** The table should use the wide landscape layout (.tv-ls). */
  ls: boolean;
  /** The phone is held in PORTRAIT → CSS-rotate the table 90° (.tv-forced). */
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

    const realLandscape = window.matchMedia('(orientation: landscape) and (max-height: 560px)');
    // Portrait phone → force-rotate. NOTE: no `(pointer: coarse)` clause — some phones
    // and device emulators don't report it, which silently disabled the rotation.
    const phonePortrait = window.matchMedia('(orientation: portrait) and (max-width: 932px)');
    const update = () => setState({ ls: realLandscape.matches || phonePortrait.matches, forced: phonePortrait.matches });
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
