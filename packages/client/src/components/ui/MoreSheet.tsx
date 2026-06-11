// "More" bottom sheet (mobile) — the nav destinations the 5 bottom-bar tabs don't
// cover, so nothing is lost on phones. Portal + backdrop + Escape-to-close.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore, type LobbyView } from '../../store/uiStore.ts';
import { useAuthStore } from '../../store/authStore.ts';
import { sound } from '../../lib/sound.ts';
import { haptics } from '../../lib/haptics.ts';
import { useT } from '../../lib/i18n.ts';

interface MoreItem { icon: string; labelKey: string; to: LobbyView; admin?: boolean }
const ITEMS: MoreItem[] = [
  { icon: '🏆', labelKey: 'nav.leaderboard', to: 'leaderboard' },
  { icon: '🎯', labelKey: 'nav.challenges', to: 'rewards' },
  { icon: '🏅', labelKey: 'nav.tournaments', to: 'tournaments' },
  { icon: '♛', labelKey: 'nav.vip', to: 'vip' },
  { icon: '🛡️', labelKey: 'nav.clubs', to: 'clubs' },
  { icon: '❓', labelKey: 'nav.support', to: 'support' },
  { icon: '⚙️', labelKey: 'topbar.adminPanel', to: 'admin', admin: true },
];

export function MoreSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const role = useAuthStore((s) => s.user?.role);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = ITEMS.filter((i) => !i.admin || role === 'admin');

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-end justify-center bg-black/60 md:hidden"
      role="dialog"
      aria-modal="true"
      aria-label={t('nav.more')}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md panel-solid rounded-t-3xl p-4 animate-rise"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-3" aria-hidden />
        <div className="grid grid-cols-3 gap-2">
          {items.map((i) => (
            <button
              key={i.labelKey}
              type="button"
              className="flex flex-col items-center gap-1.5 rounded-xl py-3 border border-white/10 bg-white/[.03] hover:border-gold transition-all"
              onClick={() => { sound.play('button'); haptics.tap(); setView(i.to); onClose(); }}
            >
              <span className="text-2xl">{i.icon}</span>
              <span className="text-[11px] text-muted text-center leading-tight">{t(i.labelKey)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
