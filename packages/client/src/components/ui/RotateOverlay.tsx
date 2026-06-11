import { useT } from '../../lib/i18n.ts';

/** Full-screen "rotate your phone to landscape" prompt — shown over the game when a
 *  phone is held in PORTRAIT (the table is landscape-only). The parent decides when
 *  to render it (see useForceLandscape `forced`). On Android the hook also hard-locks
 *  to landscape, so this only ever shows on iOS / where the lock isn't supported. */
export function RotateOverlay() {
  const t = useT();
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
