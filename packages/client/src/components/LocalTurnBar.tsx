import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n.ts';

/**
 * Prominent "your turn" indicator for the LOCAL player. Unlike opponents (who get a
 * ring around their avatar), the local player has NO avatar on the felt — their hand
 * sits at the bottom — so without this their turn was only a tiny label + the small
 * top-bar timer, easy to miss, and the silent 30s auto-pass would fire. Here a
 * full-width bar DEPLETES over the remaining turn time (pure CSS, keyed by the
 * server deadline) with a live seconds count, turning red in the final seconds.
 */
export function LocalTurnBar({ deadline }: { deadline: number | null }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [deadline]);

  // No server deadline (e.g. an untimed game) — still flag the turn loudly.
  if (deadline === null) {
    return (
      <div className="text-center pb-1">
        <span className="animate-pop gold-text font-display font-bold tracking-wide text-base uppercase">{t('table.yourTurn')}</span>
      </div>
    );
  }

  const remainingMs = Math.max(0, deadline - now);
  const secs = Math.ceil(remainingMs / 1000);
  const low = secs <= 5;
  return (
    <div className="px-3 pb-1.5">
      <div className="flex items-center justify-center gap-2.5 pb-1">
        <span className={`animate-pop font-display font-bold tracking-wide text-lg uppercase ${low ? 'text-red-200' : 'gold-text'}`}>
          {t('table.yourTurn')}
        </span>
        <span className={`tabular-nums text-xl font-bold leading-none ${low ? 'text-red-300' : 'text-gold-hi'}`}>{secs}s</span>
      </div>
      <div className="local-turn-bar" aria-hidden>
        {/* key={deadline} restarts the depletion animation on each new turn */}
        <div key={deadline} className={`local-turn-bar-fill ${low ? 'low' : ''}`} style={{ animationDuration: `${remainingMs}ms` }} />
      </div>
    </div>
  );
}
