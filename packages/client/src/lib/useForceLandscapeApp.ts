import { useEffect, useState } from 'react';

/**
 * Is this a PHONE or TABLET (iOS / Android), as opposed to a desktop/laptop?
 * - Touchscreen laptops report a FINE pointer + hover, so `(hover: none) and (pointer: coarse)`
 *   excludes them while catching phones/tablets.
 * - iPadOS 13+ sends a desktop-class ("Macintosh") UA, so we also treat a Mac-UA WITH multi-touch
 *   as an iPad.
 * - A plain mobile/tablet UA covers everything else (incl. emulators that mis-report pointer media).
 * Desktops (no touch, fine pointer) return false → never forced.
 */
export function isMobileOrTablet(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|PlayBook|BlackBerry|Opera Mini|IEMobile/i.test(ua);
  const iPadOS = (navigator.maxTouchPoints ?? 0) > 1 && /Macintosh|Mac OS X/.test(ua);
  const coarseNoHover = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  return mobileUA || iPadOS || coarseNoHover;
}

/**
 * App-wide landscape lock for phones & tablets. Returns TRUE when the UI should be blocked by the
 * rotate prompt — i.e. the device is a phone/tablet held in PORTRAIT. Desktops/laptops always
 * return false (they keep the normal portrait layout). Best-effort hard-locks the orientation to
 * landscape where the platform allows it (Android / installed PWA); iOS has no lock API, so the
 * rotate prompt is the fallback there.
 */
export function useForceLandscapeApp(): boolean {
  // Decide device class ONCE (it can't change at runtime) so SSR/first paint is stable.
  const [mobile] = useState(isMobileOrTablet);
  const [portrait, setPortrait] = useState(false);

  useEffect(() => {
    if (!mobile) return; // desktop/laptop → never force landscape
    const orientation = screen.orientation as
      | (ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void })
      | undefined;
    try { void orientation?.lock?.('landscape')?.catch(() => {}); } catch { /* unsupported (iOS) */ }

    // Always-landscape. We MEASURE the real screen with window.innerWidth/innerHeight (in the installed
    // standalone app — no Safari toolbar — these are EXACT, full-screen) and publish them as CSS vars
    // --app-w / --app-h, RE-MEASURED on every resize/orientationchange. This is the key fix for "after
    // rotating to landscape and back, portrait shrinks": iOS does NOT reliably recompute CSS dvh/dvw on
    // rotation (they keep the previous orientation's value), but innerWidth/innerHeight + a resize re-read
    // are always fresh. Orientation decision uses matchMedia (reliable); dims use inner* (recomputed).
    const el = document.documentElement;
    let settleTimer = 0;
    const apply = () => {
      const isPortrait = window.matchMedia('(orientation: portrait)').matches;
      el.style.setProperty('--app-w', `${window.innerWidth}px`);  // real screen WIDTH
      el.style.setProperty('--app-h', `${window.innerHeight}px`); // real screen HEIGHT
      el.classList.toggle('force-landscape', isPortrait);
      setPortrait(isPortrait);
    };
    // While the phone is physically rotating (portrait<->landscape), iOS animates the viewport AND we
    // flip the CSS frame — the combo makes entrance/transition animations replay and the app appear to
    // "spin". Add `rotating` to <html> across the turn so animations/transitions are killed (index.css);
    // clear it once the orientation settles. Result: a clean cut, not a visible rotation effect.
    const onRotate = () => {
      el.classList.add('rotating');
      apply();
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => { el.classList.remove('rotating'); apply(); }, 500);
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', onRotate);
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    return () => {
      window.clearTimeout(settleTimer);
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', onRotate);
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
      el.classList.remove('force-landscape', 'rotating');
      el.style.removeProperty('--app-w');
      el.style.removeProperty('--app-h');
      try { orientation?.unlock?.(); } catch { /* noop */ }
    };
  }, [mobile]);

  return mobile && portrait;
}
