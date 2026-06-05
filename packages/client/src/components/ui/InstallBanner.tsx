// "Install the app" banner — shown only when the browser reports the app is
// installable (Android / desktop Chrome). Hidden on iOS (installs via Share menu)
// and once installed.
import { useCanInstall, promptInstall } from '../../lib/pwa.ts';
import { sound } from '../../lib/sound.ts';

export function InstallBanner() {
  const canInstall = useCanInstall();
  if (!canInstall) return null;
  return (
    <button
      onClick={() => { sound.play('button'); void promptInstall(); }}
      className="w-full panel p-3 flex items-center justify-between gap-3 hover:border-gold transition-all animate-rise text-left"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-2xl shrink-0">📲</span>
        <div className="min-w-0">
          <div className="font-display font-semibold text-gold-hi tracking-wide text-sm">INSTALO APLIKACIONIN</div>
          <div className="text-[11px] text-muted truncate">Luaj si aplikacion — në ekran të plotë, më shpejt.</div>
        </div>
      </div>
      <span className="btn btn-ghost shrink-0">Instalo</span>
    </button>
  );
}
