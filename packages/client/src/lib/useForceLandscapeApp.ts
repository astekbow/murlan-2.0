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

    // DEFINITIVE always-landscape: don't trust CSS viewport units (vh/dvh) or media queries — they're
    // unreliable on iOS (Safari's toolbar makes 100vh ≠ the visible area). Instead MEASURE the real
    // visible pixels with visualViewport and drive an exact, pixel-sized rotated frame via CSS vars
    // (--app-w / --app-h, consumed in index.css). ONE self-correcting path: if the measured viewport is
    // portrait → rotate; if it's already landscape (held sideways, or an OS/PWA lock took) → do nothing.
    // Works the same in a browser tab AND an installed PWA, on any iOS version. No stretch, no glitch.
    const el = document.documentElement;
    const apply = () => {
      const vv = window.visualViewport;
      const w = Math.round(vv?.width ?? window.innerWidth);
      const h = Math.round(vv?.height ?? window.innerHeight);
      const isPortrait = h > w;
      setPortrait(isPortrait);
      if (isPortrait) {
        el.style.setProperty('--app-w', `${w}px`); // real visible WIDTH  (= rotated frame HEIGHT)
        el.style.setProperty('--app-h', `${h}px`); // real visible HEIGHT (= rotated frame WIDTH)
        el.classList.add('force-landscape');
      } else {
        el.classList.remove('force-landscape');
        el.style.removeProperty('--app-w');
        el.style.removeProperty('--app-h');
      }
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    window.visualViewport?.addEventListener('resize', apply);
    window.visualViewport?.addEventListener('scroll', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.visualViewport?.removeEventListener('resize', apply);
      window.visualViewport?.removeEventListener('scroll', apply);
      el.classList.remove('force-landscape');
      el.style.removeProperty('--app-w');
      el.style.removeProperty('--app-h');
      try { orientation?.unlock?.(); } catch { /* noop */ }
    };
  }, [mobile]);

  return mobile && portrait;
}
