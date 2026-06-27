import { useEffect, useState } from 'react';
import { isMobileOrTablet } from './useForceLandscapeApp.ts';

/** True when the page should use its fixed-height, two-pane landscape "console" (fits with NO page
 *  scroll). That's the case in BOTH states the app is displayed as landscape:
 *   • the phone is physically held HORIZONTALLY (short landscape), OR
 *   • the phone is held PORTRAIT and the whole app is CSS-rotated to landscape (force-landscape) on a
 *     mobile device. Without this, a rotated portrait phone would render the tall stacked PORTRAIT
 *     layout sideways. Desktops/large tablets keep the normal stacked, scrollable layout. */
export function useLandscapePage(): boolean {
  const [ls, setLs] = useState(false);
  useEffect(() => {
    const realLs = window.matchMedia('(orientation: landscape) and (max-height: 600px)');
    const portrait = window.matchMedia('(orientation: portrait)');
    const mobile = isMobileOrTablet();
    const update = () => setLs(realLs.matches || (mobile && portrait.matches));
    update();
    realLs.addEventListener('change', update);
    portrait.addEventListener('change', update);
    return () => {
      realLs.removeEventListener('change', update);
      portrait.removeEventListener('change', update);
    };
  }, []);
  return ls;
}
