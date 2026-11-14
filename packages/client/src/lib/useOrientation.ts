import { useEffect, useState } from 'react';

/** True while the viewport is LANDSCAPE (wider than tall) — phones held flat, tablets, desktops.
 *  The game table uses it to pick its layout; it follows rotation live (no lock, no rotate prompt). */
export function useIsLandscape(): boolean {
  const query = '(orientation: landscape)';
  const [ls, setLs] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setLs(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return ls;
}
