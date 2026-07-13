// "Install the app" prompt as a dismissible modal (bottom sheet on phones) shown
// once at startup — with a close button and a "don't remind me again" that sticks
// (localStorage). On Android/desktop Chrome it offers a one-tap install; on iOS it
// shows the Share → Add to Home Screen hint. Never shown once installed.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useCanInstall, isIos, isStandalone, promptInstall } from '../../lib/pwa.ts';
import { useUiStore } from '../../store/uiStore.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';
import { InstallGuide } from './InstallGuide.tsx';

const DISMISS_KEY = 'murlan.installDismissed';

export function InstallModal() {
  const canInstall = useCanInstall();
  const t = useT();
  const [closed, setClosed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const installOpen = useUiStore((s) => s.installOpen);
  const setInstallOpen = useUiStore((s) => s.setInstallOpen);
  const iosHint = isIos() && !isStandalone();

  // Already installed → nothing to offer. Otherwise show when force-opened from Settings, OR
  // (auto) the first time if not dismissed and there's an install path for this platform.
  if (isStandalone()) return null;
  if (!installOpen && (closed || (!canInstall && !iosHint))) return null;

  const dismiss = (forever: boolean) => {
    if (forever) { try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ } }
    setClosed(true);
    setInstallOpen(false); // also clears a force-open from Settings
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-end sm:items-center justify-center bg-black/60 p-3 sm:p-4"
      style={{ paddingLeft: 'max(0.75rem, env(safe-area-inset-left))', paddingRight: 'max(0.75rem, env(safe-area-inset-right))' }}
      role="dialog"
      aria-modal="true"
      aria-label={t('install.title')}
      onClick={() => dismiss(false)}
    >
      <div
        className="panel-solid rounded-2xl p-5 w-full max-w-sm animate-rise relative max-h-[92dvh] overflow-y-auto overscroll-contain"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => dismiss(false)}
          className="absolute top-2 right-2 w-11 h-11 grid place-items-center rounded-full hover:bg-white/10 text-muted text-lg"
          aria-label={t('install.close')}
        >
          ✕
        </button>
        {/* The real app icon (same treatment as the login card) — this IS what they're installing. */}
        <img src="/icon-192.png" alt="" className="w-14 h-14 rounded-2xl shadow-lg ring-1 ring-gold/25 mb-3" />
        <div className="font-display font-bold text-gold-hi text-lg pr-8">{t('install.title')}</div>
        <p className="text-sm text-muted mt-1">{t('install.subtitle')}</p>
        {canInstall ? (
          <button
            type="button"
            className="btn btn-gold btn-lg btn-block mt-4"
            onClick={() => { sound.play('button'); void promptInstall(); dismiss(false); }}
          >
            {t('install.cta')}
          </button>
        ) : iosHint ? (
          // iOS: the shared, canonical install flow (one-tap profile + manual fallback with the real
          // Share glyph). Same component the login-screen "Get the app" guide renders, so they match.
          <div className="mt-4">
            <InstallGuide onProfileClick={() => sound.play('button')} />
          </div>
        ) : (
          // Force-opened from Settings on a desktop / unsupported browser: nothing to install here.
          <p className="text-sm text-muted mt-4 leading-relaxed">{t('install.openOnPhone')}</p>
        )}
        <button type="button" className="btn btn-ghost btn-block mt-2 text-sm" onClick={() => dismiss(true)}>
          {t('install.dontRemind')}
        </button>
      </div>
    </div>,
    document.getElementById('root') ?? document.body,
  );
}
