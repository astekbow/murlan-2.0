import { useEffect, useState } from 'react';

/** True when the page should use its fixed-height, two-pane landscape "console" (fits with NO page
 *  scroll) — i.e. a phone held HORIZONTALLY (short landscape). Portrait phones get the rotate prompt
 *  (App-level), so they never render a page; desktops/large tablets keep the normal stacked layout. */
export function useLandscapePage(): boolean {
  const [ls, setLs] = useState(false);
  useEffect(() => {
    const realLs = window.matchMedia('(orientation: landscape) and (max-height: 600px)');
    const update = () => setLs(realLs.matches);
    update();
    realLs.addEventListener('change', update);
    return () => realLs.removeEventListener('change', update);
  }, []);
  return ls;
}
