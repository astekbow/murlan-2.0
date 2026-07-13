import { useT } from '../../lib/i18n.ts';

/** Full-screen "rotate your phone to landscape" prompt — shown over the game when a
 *  phone is held in PORTRAIT (the table is landscape-only). The parent decides when
 *  to render it (see useForceLandscape `forced`). On Android the hook also hard-locks
 *  to landscape, so this only ever shows on iOS / where the lock isn't supported.
 *
 *  Fully branded ("Obsidian & Gold"): the MURLAN crest, an animated gold phone that
 *  tips portrait→landscape (with a rotation-arc cue), on the obsidian + gold vignette. */
export function RotateOverlay() {
  const t = useT();
  return (
    <div
      // Announce the rotate prompt when it appears (audit L8) — on iOS this overlay is the only
      // signal that the app is intentionally blocked until the phone is turned to landscape.
      role="status"
      aria-live="assertive"
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-6 text-center px-8"
      style={{
        // Match the rest of the app: obsidian ramp + a soft gold vignette, with an extra
        // centred glow behind the phone so it reads as a lit centrepiece, not a flat screen.
        background:
          'radial-gradient(90% 55% at 50% 42%, rgba(232, 200, 121, 0.10), transparent 60%),' +
          'radial-gradient(120% 80% at 50% -8%, rgba(232, 200, 121, 0.06), transparent 55%),' +
          'radial-gradient(100% 90% at 50% 118%, rgba(58, 15, 22, 0.55), transparent 62%),' +
          'linear-gradient(180deg, var(--bg-1), var(--bg-0) 64%)',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Brand lockup — mirrors the login card identity (eyebrow + crest wordmark). */}
      <div className="flex flex-col items-center gap-1">
        <div className="font-serif text-[10px] tracking-[0.35em] text-muted/80 uppercase">Card Club</div>
        <div className="crest gold-text text-[22px] leading-none">MURLAN</div>
      </div>

      {/* Animated gold phone tipping portrait→landscape, with a rotation-arc cue. */}
      <svg viewBox="0 0 120 120" className="w-32 h-32" role="img" aria-hidden="true">
        <defs>
          <linearGradient id="rotGold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff3cf" />
            <stop offset="0.55" stopColor="#e8c879" />
            <stop offset="1" stopColor="#a9842f" />
          </linearGradient>
          <radialGradient id="rotGlow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="rgba(232,200,121,0.30)" />
            <stop offset="1" stopColor="rgba(232,200,121,0)" />
          </radialGradient>
          <linearGradient id="rotScreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1b1922" />
            <stop offset="1" stopColor="#0b0a0e" />
          </linearGradient>
        </defs>

        {/* Soft glow pool behind the device. */}
        <circle cx="60" cy="60" r="42" fill="url(#rotGlow)" />

        {/* Rotation-arc cue (static) — arches over the phone with an arrowhead. */}
        <g opacity="0.55">
          <path d="M 24 42 Q 60 8 96 42" fill="none" stroke="url(#rotGold)" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M 96 42 L 85 39 L 92 31 Z" fill="url(#rotGold)" />
        </g>

        {/* The phone — this whole group tips about its own centre. */}
        <g className="rotate-phone-anim">
          <rect x="45" y="27" width="30" height="66" rx="7" ry="7" fill="url(#rotScreen)" stroke="url(#rotGold)" strokeWidth="2.4" />
          <rect x="48.5" y="34" width="23" height="48" rx="2.5" fill="url(#rotGlow)" opacity="0.6" />
          {/* speaker slot + home indicator */}
          <line x1="55" y1="31" x2="65" y2="31" stroke="url(#rotGold)" strokeWidth="1.4" strokeLinecap="round" opacity="0.85" />
          <line x1="55" y1="89" x2="65" y2="89" stroke="url(#rotGold)" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
        </g>
      </svg>

      <div className="flex flex-col items-center gap-2">
        <div className="gold-text font-display font-bold text-2xl tracking-wide">{t('table.rotateTitle')}</div>
        <div className="text-sm text-muted max-w-xs leading-relaxed">{t('table.rotateHint')}</div>
      </div>
    </div>
  );
}
