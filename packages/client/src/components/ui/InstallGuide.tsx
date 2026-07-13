// Canonical iOS "install as an app" flow — the single source of truth used by BOTH the
// auto InstallModal bottom-sheet AND the login-screen "Get the app" guide, so the two can
// never drift. Primary path is the one-tap configuration profile; a manual "Add to Home
// Screen" list (with the REAL iOS Share glyph) is the fallback. Owns its own reachability
// check of the profile endpoint so both callers behave identically.
import { useState, useEffect, type ReactNode } from 'react';
import { useT } from '../../lib/i18n.ts';

/** The real iOS "Share" glyph — a rounded box with an up-arrow poking out of the top.
 *  Replaces the hand-faked "↑ in a box". Inherits colour via currentColor; size via className. */
export function ShareIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M8 11H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

function Num({ children }: { children: ReactNode }) {
  return <span className="shrink-0 w-6 h-6 grid place-items-center rounded-full bg-gold/15 text-gold-hi font-display font-bold text-xs">{children}</span>;
}

export function InstallGuide({ onProfileClick }: { onProfileClick?: () => void }) {
  const t = useT();
  // Verify the iOS profile endpoint is actually serving (signing cert mounted, route up) so we can
  // steer straight to the manual steps instead of dangling a dead button / silent blank download.
  const [profileOk, setProfileOk] = useState(true);
  useEffect(() => {
    let alive = true;
    fetch('/api/install/ios.mobileconfig', { method: 'HEAD' })
      .then((r) => { if (alive) setProfileOk(r.ok); })
      .catch(() => { if (alive) setProfileOk(false); });
    return () => { alive = false; };
  }, []);

  return (
    <div>
      {profileOk ? (
        // Primary: one-tap CONFIGURATION-PROFILE install (downloads → Settings → Install), built by
        // the server for THIS origin.
        <>
          <a href="/api/install/ios.mobileconfig" className="btn btn-gold btn-lg btn-block" onClick={onProfileClick}>
            {t('install.iosProfileCta')}
          </a>
          <p className="text-[12px] text-muted/85 mt-2 leading-relaxed">{t('install.iosProfileHint')}</p>
        </>
      ) : (
        // Profile endpoint unreachable (signing/route down) → don't dangle a dead button; steer to manual.
        <p className="text-[12px] text-amber-300 leading-relaxed bg-amber-500/10 border border-amber-400/40 rounded-lg px-3 py-2">{t('install.iosProfileUnavailable')}</p>
      )}

      {/* Manual "Add to Home Screen" fallback — real Share glyph in step 1, unified copy. */}
      <details className="mt-3" open={!profileOk}>
        <summary className="text-xs text-muted cursor-pointer select-none">{t('install.iosManualToggle')}</summary>
        <ol className="mt-3 space-y-3 text-[13px] text-txt">
          <li className="flex items-center gap-2.5">
            <Num>1</Num>
            <span className="flex items-center gap-1.5 leading-relaxed">
              {t('install.iosStep1')}
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-gold/40 text-gold-hi shrink-0"><ShareIcon className="w-3.5 h-3.5" /></span>
            </span>
          </li>
          <li className="flex items-center gap-2.5"><Num>2</Num><span className="leading-relaxed">{t('install.iosStep2')}</span></li>
          <li className="flex items-center gap-2.5"><Num>3</Num><span className="leading-relaxed">{t('install.iosStep3')}</span></li>
        </ol>
        {/* What they'll be looking for afterwards — the real home-screen icon. */}
        <div className="flex items-center gap-3 mt-4 pt-3 border-t border-white/10">
          <img src="/apple-touch-icon.png" alt="" className="w-10 h-10 rounded-xl ring-1 ring-gold/25 shrink-0" />
          <span className="text-[12px] text-muted leading-snug">{t('install.iosHomeIconNote')}</span>
        </div>
      </details>
    </div>
  );
}
