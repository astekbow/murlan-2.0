// "Install the app" prompt as a dismissible modal (bottom sheet on phones) shown
// once at startup — with a close button and a "don't remind me again" that sticks
// (localStorage). On Android/desktop Chrome it offers a one-tap install; on iOS it
// shows the Share → Add to Home Screen hint. Never shown once installed.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useCanInstall, isIos, isStandalone, promptInstall } from '../../lib/pwa.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';

const DISMISS_KEY = 'murlan.installDismissed';

export function InstallModal() {
  const canInstall = useCanInstall();
  const t = useT();
  const [closed, setClosed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const iosHint = isIos() && !isStandalone();

  // Nothing to offer (already installed, or no install path), or the user dismissed it.
  if (closed || isStandalone() || (!canInstall && !iosHint)) return null;

  const dismiss = (forever: boolean) => {
    if (forever) { try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ } }
    setClosed(true);
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
        className="panel-solid rounded-2xl p-5 w-full max-w-sm animate-rise relative"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => dismiss(false)}
          className="absolute top-3 right-3 w-9 h-9 grid place-items-center rounded-full hover:bg-white/10 text-muted text-lg"
          aria-label={t('install.close')}
        >
          ✕
        </button>
        <div className="text-4xl mb-2">📲</div>
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
        ) : (
          // iOS: one-tap CONFIGURATION-PROFILE install (downloads → Settings → Install). Built by the
          // server for THIS origin. A collapsed manual "Add to Home Screen" stays as a fallback.
          <>
            <a
              href="/api/install/ios.mobileconfig"
              className="btn btn-gold btn-lg btn-block mt-4"
              onClick={() => sound.play('button')}
            >
              {t('install.iosProfileCta')}
            </a>
            <p className="text-[11px] text-muted/80 mt-2 leading-relaxed">{t('install.iosProfileHint')}</p>
            <details className="mt-3">
              <summary className="text-xs text-muted cursor-pointer select-none">{t('install.iosManualToggle')}</summary>
              <ol className="mt-2.5 space-y-2.5 text-sm text-txt">
                <li className="flex items-center gap-2.5">
                  <span className="shrink-0 w-6 h-6 grid place-items-center rounded-full bg-gold/15 text-gold-hi font-display font-bold text-xs">1</span>
                  <span className="flex items-center gap-1.5">{t('install.iosStep1')}
                    <span aria-hidden className="inline-flex items-center justify-center w-5 h-6 rounded-[5px] border border-current leading-none relative -top-px">↑</span>
                  </span>
                </li>
                <li className="flex items-center gap-2.5">
                  <span className="shrink-0 w-6 h-6 grid place-items-center rounded-full bg-gold/15 text-gold-hi font-display font-bold text-xs">2</span>
                  <span>{t('install.iosStep2')}</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <span className="shrink-0 w-6 h-6 grid place-items-center rounded-full bg-gold/15 text-gold-hi font-display font-bold text-xs">3</span>
                  <span>{t('install.iosStep3')}</span>
                </li>
              </ol>
            </details>
          </>
        )}
        <button type="button" className="btn btn-ghost btn-block mt-2 text-sm" onClick={() => dismiss(true)}>
          {t('install.dontRemind')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
