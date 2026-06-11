import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n.ts';

/** Covers the game table when a phone is held in PORTRAIT — the table is designed
 *  for landscape. Best-effort locks to landscape on Android (no-op on iOS Safari,
 *  which doesn't support orientation lock — the overlay covers that case). */
export function RotateOverlay() {
  const t = useT();
  const [portrait, setPortrait] = useState(false);

  useEffect(() => {
    // Best-effort orientation lock (Android / installed PWA). iOS throws / is
    // undefined → ignored; the overlay below handles it.
    const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void }) | undefined;
    try { void orientation?.lock?.('landscape')?.catch(() => {}); } catch { /* unsupported */ }

    // Only nag on touch phones held in portrait (not desktop / large tablets).
    const mq = window.matchMedia('(orientation: portrait) and (max-width: 932px) and (pointer: coarse)');
    const update = () => setPortrait(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => {
      mq.removeEventListener('change', update);
      try { orientation?.unlock?.(); } catch { /* noop */ }
    };
  }, []);

  if (!portrait) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-4 text-center px-8"
      style={{
        background: 'var(--bg-0)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="text-7xl rotate-hint" aria-hidden>📱</div>
      <div className="gold-text font-display font-bold text-2xl tracking-wide">{t('table.rotateTitle')}</div>
      <div className="text-sm text-muted max-w-xs leading-relaxed">{t('table.rotateHint')}</div>
    </div>
  );
}
