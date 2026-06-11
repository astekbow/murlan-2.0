// Mobile bottom tab bar (phones only — md:hidden). Five primary destinations;
// the rest live in the "More" sheet. Desktop keeps the side RailNav untouched.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore, type LobbyView } from '../../store/uiStore.ts';
import { sound } from '../../lib/sound.ts';
import { haptics } from '../../lib/haptics.ts';
import { useT } from '../../lib/i18n.ts';
import { MoreSheet } from './MoreSheet.tsx';

// Views reachable only via the "More" sheet — the More tab lights up for these.
const MORE_VIEWS: LobbyView[] = ['leaderboard', 'rewards', 'vip', 'tournaments', 'support', 'clubs', 'admin'];

interface Tab { icon: string; labelKey: string; to: LobbyView | 'more' }
const TABS: Tab[] = [
  { icon: '🏠', labelKey: 'nav.home', to: 'lobby' },
  { icon: '💰', labelKey: 'nav.wallet', to: 'wallet' },
  { icon: '🛍️', labelKey: 'nav.shop', to: 'shop' },
  { icon: '👥', labelKey: 'nav.friends', to: 'friends' },
  { icon: '☰', labelKey: 'nav.more', to: 'more' },
];

export function BottomNav() {
  const t = useT();
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (to: Tab['to']) => (to === 'more' ? MORE_VIEWS.includes(view) : view === to);

  return createPortal(
    <>
      <nav className="bottom-nav md:hidden" aria-label={t('nav.more')}>
        {TABS.map((tab) => {
          const active = isActive(tab.to);
          return (
            <button
              key={tab.labelKey}
              type="button"
              className={`bn-item ${active ? 'active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                sound.play('button');
                haptics.tap();
                if (tab.to === 'more') setMoreOpen(true);
                else setView(tab.to);
              }}
            >
              <span className="bn-ic">{tab.icon}</span>
              <span>{t(tab.labelKey)}</span>
            </button>
          );
        })}
      </nav>
      {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
    </>,
    document.body,
  );
}
