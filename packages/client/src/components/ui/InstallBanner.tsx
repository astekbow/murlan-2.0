// "Install the app" banner. On Android/desktop Chrome the browser fires an install
// event → we show a one-tap button. iOS has no such event, so we show a short
// "Add to Home Screen" instruction instead. Hidden once the app is installed.
import { useCanInstall, isIos, isStandalone, promptInstall } from '../../lib/pwa.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';

export function InstallBanner() {
  const canInstall = useCanInstall();
  const t = useT();

  // Android / desktop Chrome: real one-tap install.
  if (canInstall) {
    return (
      <button
        onClick={() => { sound.play('button'); void promptInstall(); }}
        className="w-full panel p-3 flex items-center justify-between gap-3 hover:border-gold transition-all animate-rise text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xl shrink-0">📲</span>
          <div className="min-w-0">
            <div className="font-display font-semibold text-gold-hi tracking-wide text-sm">{t('install.title')}</div>
            <div className="text-[11px] text-muted truncate">{t('install.subtitle')}</div>
          </div>
        </div>
        <span className="btn btn-ghost shrink-0">{t('install.cta')}</span>
      </button>
    );
  }

  // iOS (no install event): tell the user how to add it from the Share menu.
  if (isIos() && !isStandalone()) {
    return (
      <div className="w-full panel p-3 flex items-center gap-3 animate-rise">
        <span className="text-2xl shrink-0">📲</span>
        <div className="min-w-0">
          <div className="font-display font-semibold text-gold-hi tracking-wide text-sm">{t('install.title')}</div>
          <div className="text-[11px] text-muted">{t('install.iosHint')}</div>
        </div>
      </div>
    );
  }

  return null;
}