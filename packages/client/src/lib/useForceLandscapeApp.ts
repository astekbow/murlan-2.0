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

    // Always-landscape — sizing the rotated frame correctly on iOS needs a measurement that is BOTH
    // full-screen AND fresh after a rotate. None of the obvious ones are both:
    //   • CSS 100dvh/100dvw   → full-screen, but iOS leaves them STALE after a rotate (prev orientation).
    //   • window.innerW/innerH → fresh, but EXCLUDE the safe-area insets → too small → everything shrank.
    // So we measure a hidden PROBE: position:fixed; inset:0 + viewport-fit=cover = the FULL screen incl.
    // safe areas, and offsetWidth/Height re-read FRESH every time. Published as --app-w/--app-h, consumed
    // by the frame/app-shell/canvas in index.css. Re-measured on every resize/orientationchange.
    const el = document.documentElement;
    let settleTimer = 0;
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;visibility:hidden;pointer-events:none;z-index:-1;';
    document.body.appendChild(probe);
    const apply = () => {
      const w = probe.offsetWidth || window.innerWidth;
      const h = probe.offsetHeight || window.innerHeight;
      const isPortrait = h >= w;
      el.style.setProperty('--app-w', `${w}px`);  // real full-screen WIDTH
      el.style.setProperty('--app-h', `${h}px`);  // real full-screen HEIGHT
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
      probe.remove();
      try { orientation?.unlock?.(); } catch { /* noop */ }
    };
  }, [mobile]);

  return mobile && portrait;
}
