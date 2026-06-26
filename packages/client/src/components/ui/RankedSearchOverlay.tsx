// Full-screen "searching for opponents" overlay shown while the player is in the
// ranked matchmaking queue. Disappears automatically once a match is found (the
// server seats the player into a room → gameStore clears `queue` + sets `room`).
import type { MatchType } from '@murlan/shared';
import { useGameStore } from '../../store/gameStore.ts';
import { useFocusTrap } from './useFocusTrap.ts';
import { useT } from '../../lib/i18n.ts';

const TYPE_LABEL_KEY: Record<MatchType, string> = {
  '1v1': 'rankedsearch.type1v1',
  '1v1v1': 'rankedsearch.type1v1v1',
  '2v2': 'rankedsearch.type2v2',
};

export function RankedSearchOverlay() {
  const t = useT();
  const queue = useGameStore((s) => s.queue);
  const room = useGameStore((s) => s.room);
  const cancelRanked = useGameStore((s) => s.cancelRanked);
  // Trap Tab within the overlay + announce it to a screen reader (audit L7). Hook is called
  // unconditionally (the ref is inert until the dialog mounts) to keep hook order stable.
  const trapRef = useFocusTrap<HTMLDivElement>(!!queue && !room);
  if (!queue || room) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 backdrop-blur-sm">
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('rankedsearch.title')}
        className="panel p-8 text-center max-w-sm mx-4 animate-pop"
      >
        <div className="text-5xl mb-3 animate-pulse" aria-hidden>⚔️</div>
        <h2 className="font-display font-bold text-xl gold-text tracking-wide">{t('rankedsearch.title')}</h2>
        {/* Live region: announces that matchmaking started + the queue fills (size/needed). */}
        <p role="status" aria-live="polite" className="text-sm text-muted mt-2">
          {t('rankedsearch.subtitle')} · {t(TYPE_LABEL_KEY[queue.matchType])}
          <span className="sr-only"> — {t('rankedsearch.playerCount', { size: queue.size, needed: queue.needed })}</span>
        </p>
        <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
          {Array.from({ length: Math.max(queue.needed, 1) }).map((_, i) => (
            <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < queue.size ? 'bg-gold' : 'bg-white/15'}`} />
          ))}
        </div>
        <p className="text-xs text-muted mt-2" aria-hidden>{t('rankedsearch.playerCount', { size: queue.size, needed: queue.needed })}</p>
        <button onClick={cancelRanked} className="btn btn-ghost mt-5">{t('common.cancel')}</button>
      </div>
    </div>
  );
}
