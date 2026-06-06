// Global top bar shown on every lobby-area screen: profile (avatar + level ring
// + XP) on the left; balance chip (with a "+" that opens the wallet) plus
// notification and settings icon buttons on the right. Visual only — it reads
// existing stores and never changes balances or game state.
//
// NOTE: level/XP is cosmetic scaffolding for now; the progression DATA lands in
// Phase 5. The `$` balance is the real wallet figure, untouched.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '../../store/authStore.ts';
import { useUiStore } from '../../store/uiStore.ts';
import { useGameStore } from '../../store/gameStore.ts';
import { CountUp } from './CountUp.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { ProfileModal } from './ProfileModal.tsx';
import { NotificationsPanel } from './NotificationsPanel.tsx';
import { useNotifications } from '../../store/notificationsStore.ts';
import { profileApi, type Profile } from '../../lib/api.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';

function initials(name: string): string {
  const parts = name.trim().split(/[\s_]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? name[0] ?? '?';
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? '';
  return (a + b).toUpperCase();
}

export function TopBar() {
  const t = useT();
  const { user, logout } = useAuthStore();
  const setView = useUiStore((s) => s.setView);
  const connected = useGameStore((s) => s.connected);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const unread = useNotifications((s) => s.unread);

  // Fetch the signed-in user's real progression (level/XP) once when present.
  // On a null token or a failed fetch we leave `profile` null and fall back to
  // the cosmetic defaults below.
  useEffect(() => {
    if (!user) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    let alive = true;
    profileApi.me(token)
      .then(({ profile: p }) => { if (alive) setProfile(p); })
      .catch(() => { /* keep fallback */ });
    return () => { alive = false; };
  }, [user]);

  // Close the bell/gear popovers on Escape (keyboard dismissal, not just click-out).
  useEffect(() => {
    if (!menuOpen && !notifOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenuOpen(false); setNotifOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, notifOpen]);

  if (!user) return null;

  return (
    <>
    <header className="flex items-center justify-between gap-3 mb-5 animate-rise">
      {/* Profile */}
      <button
        type="button"
        onClick={() => { sound.play('button'); setProfileOpen(true); }}
        className="flex items-center gap-3 text-left"
        title={t('topbar.profile')}
      >
        <div className="pfp" style={{ width: 50, height: 50, fontSize: 16 }}>
          {initials(user.username)}
          <span className="lvl">{profile ? profile.level : 1}</span>
        </div>
        <div className="hidden sm:block">
          <div className="font-display font-semibold text-lg tracking-wide leading-none">{user.username}</div>
          <div className="xpbar">
            <i style={{ width: profile ? `${profile.levelInfo.pct * 100}%` : '12%' }} />
          </div>
        </div>
      </button>

      {/* Right cluster */}
      <div className="flex items-center gap-2.5 min-w-0">
        {!connected && (
          <span className="hidden sm:inline text-xs text-muted shrink-0">
            <span className="inline-block w-2 h-2 rounded-full bg-suit mr-1.5 animate-twinkle align-middle" />
            {t('topbar.connecting')}
          </span>
        )}
        <button type="button" className="chip max-w-[150px] overflow-hidden" onClick={() => { sound.play('button'); setView('wallet'); }} title={t('topbar.openWallet')}>
          <span className="coin shrink-0" />
          <CountUp valueCents={user.balanceCents} className="truncate" />
          <span className="plus shrink-0">+</span>
        </button>
        <div className="relative shrink-0">
          <button type="button" className="iconbtn" onClick={() => setNotifOpen((o) => !o)} title={t('topbar.notifications')} aria-label={t('topbar.notifications')} aria-haspopup="true" aria-expanded={notifOpen}>
            🔔
          </button>
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-suit text-white text-[11px] font-bold grid place-items-center pointer-events-none">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
          {notifOpen && <NotificationsPanel onClose={() => setNotifOpen(false)} />}
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            className="iconbtn"
            onClick={() => setMenuOpen((o) => !o)}
            title={t('topbar.settings')}
            aria-label={t('topbar.settings')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⚙
          </button>
          {menuOpen && createPortal(
            <>
              <div className="fixed inset-0 z-[90]" onClick={() => setMenuOpen(false)} aria-hidden />
              <div role="menu" aria-label={t('topbar.settings')} className="fixed right-3 top-16 w-44 z-[91] panel-solid p-1.5 animate-pop">
                {user.role === 'admin' && (
                  <button
                    role="menuitem"
                    className="w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-white/5 text-gold-hi"
                    onClick={() => { setMenuOpen(false); setView('admin'); }}
                  >
                    {t('topbar.adminPanel')}
                  </button>
                )}
                <button
                  role="menuitem"
                  className="w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-white/5 text-muted"
                  onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}
                >
                  {t('topbar.settings')}
                </button>
                <button
                  role="menuitem"
                  className="w-full text-left rounded-lg px-3 py-2 text-sm hover:bg-white/5 text-suit"
                  onClick={() => { setMenuOpen(false); void logout(); }}
                >
                  {t('topbar.logout')}
                </button>
              </div>
            </>,
            document.body,
          )}
        </div>
      </div>
    </header>
    {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    {profileOpen && <ProfileModal userId={user.id} onClose={() => setProfileOpen(false)} />}
    </>
  );
}
