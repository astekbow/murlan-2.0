import { useEffect } from 'react';
import { useUiStore, type LobbyView } from '../../store/uiStore.ts';
import { sound } from '../../lib/sound.ts';
import { haptics } from '../../lib/haptics.ts';
import { useT } from '../../lib/i18n.ts';
import { Icon, type IconName } from './Icon.tsx';
import { BrandMark } from './Logo.tsx';

const ITEMS: { view: LobbyView; icon: IconName; labelKey: string }[] = [
  { view: 'lobby', icon: 'home', labelKey: 'navx.lobby' },
  { view: 'rewards', icon: 'target', labelKey: 'navx.challenges' },
  { view: 'leaderboard', icon: 'trophy', labelKey: 'navx.leaderboard' },
  { view: 'friends', icon: 'users', labelKey: 'navx.friends' },
  { view: 'clubs', icon: 'shield', labelKey: 'navx.clubs' },
  { view: 'shop', icon: 'bag', labelKey: 'navx.shop' },
];

/**
 * The ONE app navigation (rebrand 2026-11), identical on every lobby-area screen so a player always
 * knows where they are and how to get anywhere in one tap: a bottom tab bar on portrait phones /
 * tablets, a slim left rail in landscape and on desktop (layout switches in CSS — `.app-nav`).
 */
export function AppNav() {
  const t = useT();
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  // Lets full-screen landscape page consoles (.pg-ls, portaled outside the shell) leave room for the rail.
  useEffect(() => {
    document.documentElement.classList.add('has-app-nav');
    return () => document.documentElement.classList.remove('has-app-nav');
  }, []);
  return (
    <nav className="app-nav" aria-label={t('nav.railPrimary')}>
      <span className="app-nav-brand" aria-hidden="true"><BrandMark size={42} /></span>
      <ul className="app-nav-list">
        {ITEMS.map((it) => {
          const active = view === it.view;
          return (
            <li key={it.view}>
              <button
                type="button"
                className={`app-nav-item${active ? ' active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  if (active) return;
                  sound.play('button');
                  haptics.tap();
                  setView(it.view);
                }}
              >
                <Icon name={it.icon} size={22} />
                <span className="app-nav-lbl">{t(it.labelKey)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
