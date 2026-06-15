// Responsible-gaming reality check: a periodic reminder (interval set in Settings)
// showing how long the player has played this session and their net result, with
// a clear "take a break" (logs out) option. Never interrupts an active match — it
// waits until the player is between games / in the lobby. Client-only.
import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../store/settingsStore.ts';
import { useAuthStore } from '../../store/authStore.ts';
import { useGameStore } from '../../store/gameStore.ts';
import { dollars } from '../../lib/money.ts';
import { formatDuration } from '../../lib/realityCheck.ts';
import { useT } from '../../lib/i18n.ts';
import { useFocusTrap } from './useFocusTrap.ts';

export function RealityCheckModal() {
  const t = useT();
  const intervalMin = useSettingsStore((s) => s.realityCheckMinutes);
  const authed = useAuthStore((s) => s.status === 'authed');
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);
  const inMatch = useGameStore((s) => s.room?.status === 'inMatch');
  const [due, setDue] = useState(false);
  const sessionStart = useRef(0);
  const startBalance = useRef(0);
  const lastCheck = useRef(0);

  useEffect(() => {
    if (!authed || intervalMin <= 0) {
      sessionStart.current = 0;
      lastCheck.current = 0;
      setDue(false);
      return;
    }
    if (sessionStart.current === 0) {
      const now = Date.now();
      sessionStart.current = now;
      lastCheck.current = now;
      startBalance.current = useAuthStore.getState().user?.balanceCents ?? 0;
    }
    if (due) return; // a reminder is already up — don't schedule another
    const delay = Math.max(1000, intervalMin * 60_000 - (Date.now() - lastCheck.current));
    const id = window.setTimeout(() => setDue(true), delay);
    return () => window.clearTimeout(id);
  }, [authed, intervalMin, due]);
  const trapRef = useFocusTrap<HTMLDivElement>(due); // keep Tab focus inside the modal while shown

  // Don't interrupt a live match; the reminder shows once the player is free.
  if (!due || !authed || inMatch) return null;

  const elapsed = Date.now() - sessionStart.current;
  const net = balanceCents - startBalance.current;
  const cont = () => { lastCheck.current = Date.now(); setDue(false); };
  const pause = () => { setDue(false); void useAuthStore.getState().logout(); };

  return (
    <div ref={trapRef} className="fixed inset-0 z-[80] grid place-items-center bg-black/75 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t('reality.title')}>
      <div className="panel-solid w-full max-w-sm p-7 text-center animate-pop mx-4">
        <div className="text-4xl mb-2">⏰</div>
        <h2 className="font-display font-bold tracking-wide text-xl text-gold-hi mb-1">{t('reality.title')}</h2>
        <p className="text-sm text-muted mb-4">{t('reality.playedFor')} <b className="text-txt">{formatDuration(elapsed)}</b> {t('reality.thisSession')}</p>
        <div className="rounded-xl bg-black/30 p-3 mb-4">
          <div className="font-serif text-[10px] tracking-[0.25em] text-muted uppercase">{t('reality.sessionResult')}</div>
          <div className={`font-display font-bold text-2xl ${net >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
            {net >= 0 ? '+' : '−'}{dollars(Math.abs(net))}
          </div>
        </div>
        <p className="text-[11px] text-muted/80 mb-4">{t('reality.responsibly')}</p>
        <div className="flex gap-2">
          <button type="button" onClick={pause} className="btn btn-ghost flex-1">{t('reality.takeBreak')}</button>
          <button type="button" autoFocus onClick={cont} className="btn btn-gold flex-1">{t('reality.continue')}</button>
        </div>
      </div>
    </div>
  );
}
