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

    // Landscape-only via a "rotate your phone" prompt (the reliable approach — CSS auto-rotation fought
    // iOS too much). We just DETECT portrait; App renders <RotateOverlay> over everything until the phone
    // is turned. In real landscape the app renders natively (perfect). On Android the orientation lock
    // above makes it real landscape, so the prompt never shows there.
    const mq = window.matchMedia('(orientation: portrait)');
    const update = () => setPortrait(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => {
      mq.removeEventListener('change', update);
      try { orientation?.unlock?.(); } catch { /* noop */ }
    };
  }, [mobile]);

  return mobile && portrait;
}
