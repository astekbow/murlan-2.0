import { useEffect, useState } from 'react';

/** True when the phone is held HORIZONTALLY (short landscape) — secondary pages then
 *  switch to a fixed-height, two-pane "console" that fits without page scroll. Desktops
 *  and portrait phones (tall) keep the normal stacked, scrollable layout.
 *
 *  The `max-height` clause is what separates a landscape PHONE (short) from a landscape
 *  desktop/tablet (tall) — only the former needs the no-scroll treatment. */
export function useLandscapePage(): boolean {
  const [ls, setLs] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape) and (max-height: 600px)');
    const update = () => setLs(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return ls;
}
