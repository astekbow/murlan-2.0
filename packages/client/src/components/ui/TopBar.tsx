// Global top bar shown on every lobby-area screen: profile (avatar + level ring
// + XP) on the left; balance chip (with a "+" that opens the wallet) plus
// notification and settings icon buttons on the right. Visual only — it reads
// existing stores and never changes balances or game state.
//
// NOTE: level/XP is cosmetic scaffolding for now; the progression DATA lands in
// Phase 5. The `$` balance is the real wallet figure, untouched.

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { avatarEmoji, isImageAvatar } from '../../lib/avatars.ts';
import { useAuthStore } from '../../store/authStore.ts';
import { useUiStore } from '../../store/uiStore.ts';
import { useGameStore } from '../../store/gameStore.ts';
import { CountUp } from './CountUp.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { ProfileModal } from './ProfileModal.tsx';
import { NotificationsPanel } from './NotificationsPanel.tsx';
import { useFocusTrap } from './useFocusTrap.ts';
import { useNotifications } from '../../store/notificationsStore.ts';
import { useSessionMinutes, formatSessionDuration } from '../../store/sessionStore.ts';
import { profileApi, type Profile } from '../../lib/api.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';
import { Icon, type IconName } from './Icon.tsx';
import { useRulesStore } from '../../store/rulesStore.ts';

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
  const sessionMinutes = useSessionMinutes();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const [popY, setPopY] = useState(64); // px from the top: where the bell / ⋯ popovers open
  const [profile, setProfile] = useState<Profile | null>(null);
  const unread = useNotifications((s) => s.unread);
  // Keyboard focus stays inside the open gear menu (Tab cycles its items, focus
  // returns to the ⚙ button on close) — same dialog semantics as the modals.
  const menuRef = useFocusTrap<HTMLDivElement>(menuOpen);

  // Fetch the signed-in user's real progression (level/XP) once when present.
  // On a null token or a failed fetch we leave `profile` null and fall back to
  // the cosmetic defaults below.
  const refetchProfile = useCallback(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    profileApi.me(token).then(({ profile: p }) => setProfile(p)).catch(() => { /* keep fallback */ });
  }, []);

  useEffect(() => {
    if (!user) return;
    refetchProfile();
  }, [user, refetchProfile]);

  // Close the bell/gear popovers on Escape (keyboard dismissal, not just click-out).
  useEffect(() => {
    if (!menuOpen && !notifOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenuOpen(false); setNotifOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, notifOpen]);

  if (!user) return null;

  // Popovers (bell / ⋯ menu) open just BELOW the top bar wherever it actually sits — under the
  // Dynamic Island / notch in a home-screen app it is ~60px lower than in a browser tab, so a fixed
  // `top-16` used to drop the menu ON the top bar.
  const popBelowBar = () => Math.round((headerRef.current?.getBoundingClientRect().bottom ?? 58) + 8);

  return (
    <>
    <header ref={headerRef} className="topbar flex items-center justify-between gap-3 mb-4 animate-rise">
      {/* Profile */}
      <button
        type="button"
        onClick={() => { sound.play('button'); setProfileOpen(true); }}
        className="flex items-center gap-3 text-left"
        title={t('topbar.profile')}
      >
        <div className="pfp" style={{ width: 50, height: 50, fontSize: 16 }}>
          {isImageAvatar(profile?.avatar) ? (
            <img src={profile!.avatar!} alt="" className="pfp-img" />
          ) : profile?.avatar ? (
            avatarEmoji(profile.avatar)
          ) : (
            initials(user.username)
          )}
          <span className="lvl">{profile ? profile.level : 1}</span>
        </div>
        <div className="min-w-0 hidden min-[460px]:block">
          <div className="font-display font-bold text-base leading-tight truncate max-w-[34vw] sm:max-w-[220px]">{user.username}</div>
          <div className="text-[11px] text-muted leading-tight">{t('topbar.levelN', { n: profile ? profile.level : 1 })}</div>
          <div className="xpbar hidden sm:block">
            <i style={{ width: profile ? `${profile.levelInfo.pct * 100}%` : '12%' }} />
          </div>
        </div>
      </button>

      {/* Right cluster */}
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Responsible-gaming session clock — subtle, hidden on the smallest screens. */}
        <span
          className="hidden md:inline text-xs text-muted shrink-0 tabular-nums"
          title={t('session.elapsedTitle')}
        >
          {t('session.playing')} {formatSessionDuration(sessionMinutes)}
        </span>
        {!connected && (
          <span className="hidden sm:inline text-xs text-muted shrink-0">
            <span className="inline-block w-2 h-2 rounded-full bg-suit mr-1.5 animate-twinkle align-middle" />
            {t('topbar.connecting')}
          </span>
        )}
        <button type="button" className="chip max-w-[170px] overflow-hidden shrink-0" onClick={() => { sound.play('button'); setView('wallet'); }} title={t('topbar.openWallet')}>
          <span className="coin shrink-0" />
          <CountUp valueCents={user.balanceCents} className="truncate" />
          <span className="plus shrink-0"><Icon name="plus" size={16} stroke={2.6} /></span>
        </button>
        <div className="relative shrink-0">
          <button type="button" className="iconbtn" onClick={() => { setPopY(popBelowBar()); setNotifOpen((o) => !o); }} title={t('topbar.notifications')} aria-label={t('topbar.notifications')} aria-haspopup="true" aria-expanded={notifOpen}>
            <Icon name="bell" />
          </button>
          {unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-suit text-white text-[11px] font-bold grid place-items-center pointer-events-none">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
          {notifOpen && <NotificationsPanel top={popY} onClose={() => setNotifOpen(false)} />}
        </div>
        <div className="relative shrink-0">
          <button
            type="button"
            className="iconbtn"
            onClick={() => { setPopY(popBelowBar()); setMenuOpen((o) => !o); }}
            title={t('topbar.settings')}
            aria-label={t('topbar.settings')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Icon name="more" size={22} stroke={3} />
          </button>
          {menuOpen && createPortal(
            <>
              <div className="fixed inset-0 z-[90]" onClick={() => setMenuOpen(false)} aria-hidden />
              <div ref={menuRef} role="menu" aria-label={t('topbar.settings')} className="fixed w-56 z-[91] panel-solid p-1.5 animate-pop" style={{ top: popY, right: 'max(0.75rem, env(safe-area-inset-right))' }}>
                {([
                  ...(user.role === 'admin' ? [{ key: 'admin', icon: 'admin', label: t('topbar.adminPanel'), tone: 'text-gold-hi', run: () => setView('admin') }] : []),
                  { key: 'vip', icon: 'crown', label: t('navx.vip'), tone: 'text-txt', run: () => setView('vip') },
                  { key: 'tournaments', icon: 'trophy', label: t('nav.tournaments'), tone: 'text-txt', run: () => setView('tournaments') },
                  { key: 'rules', icon: 'book', label: t('navx.rules'), tone: 'text-txt', run: () => useRulesStore.getState().setOpen(true) },
                  { key: 'settings', icon: 'settings', label: t('topbar.settings'), tone: 'text-txt', run: () => setSettingsOpen(true) },
                  { key: 'support', icon: 'help', label: t('topbar.support'), tone: 'text-txt', run: () => setView('support') },
                  { key: 'logout', icon: 'logout', label: t('topbar.logout'), tone: 'text-danger', run: () => { void logout(); } },
                ] as { key: string; icon: IconName; label: string; tone: string; run: () => void }[]).map((it) => (
                  <button
                    key={it.key}
                    role="menuitem"
                    className={`w-full flex items-center gap-3 text-left rounded-xl px-3 py-2.5 text-sm font-semibold hover:bg-white/5 ${it.tone}`}
                    onClick={() => { setMenuOpen(false); it.run(); }}
                  >
                    <Icon name={it.icon} size={18} className="shrink-0 opacity-80" />
                    {it.label}
                  </button>
                ))}
              </div>
            </>,
            document.getElementById('root') ?? document.body,
          )}
        </div>
      </div>
    </header>
    {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    {profileOpen && <ProfileModal userId={user.id} onClose={() => setProfileOpen(false)} onProfileChange={refetchProfile} />}
    </>
  );
}
