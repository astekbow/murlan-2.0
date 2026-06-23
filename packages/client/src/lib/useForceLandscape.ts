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

    // Gate the canvas on ASPECT-RATIO, not a magic max-height:560px (which stranded mid-size
    // landscape devices at 561–840px tall in the portrait flow while physically sideways). Any
    // wide-enough phone/tablet in landscape (≥1.5:1, capped so true desktops/large tablets are
    // excluded by max-height) gets the fixed-aspect canvas; the portrait/landscape branches are
    // now mutually exhaustive on a phone (a device is either wider-than-tall or not).
    const realLandscape = window.matchMedia('(orientation: landscape) and (min-aspect-ratio: 3/2) and (max-height: 840px)');
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
