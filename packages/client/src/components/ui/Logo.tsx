/**
 * Crypto-Murlan brand (Midnight Mint, 2026-11): a soft mint app-tile holding a midnight spade with a
 * mint "M" monogram, and the "Murlan" wordmark with a small CRYPTO pill. Pure SVG/CSS — crisp at
 * every size, no image request, and the same mark the PWA icons are rendered from.
 */

const SPADE = 'M32 5C25 14 8 25 8 38.5 8 47 14.5 53 22 53c3.6 0 6.6-1.4 8.4-3.7L28 59h8l-2.4-9.7c1.8 2.3 4.8 3.7 8.4 3.7 7.5 0 14-6 14-14.5C56 25 39 14 32 5Z';
const MONOGRAM = 'M23.5 41V29l8.5 8.5 8.5-8.5v12';

/** The square brand mark (app-icon look). `size` = px edge length. */
export function BrandMark({ size = 44, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`brand-mark ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 64 64" role="img" aria-label="Crypto-Murlan">
        <path d={SPADE} fill="#08101C" />
        <path d={MONOGRAM} fill="none" stroke="#5EEAB4" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Mark + "Murlan" wordmark + CRYPTO pill. `compact` hides the pill (tight top bars). */
export function Logo({ size = 40, compact = false, className = '' }: { size?: number; compact?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <BrandMark size={size} />
      <span className="flex flex-col leading-none">
        <span className="font-display font-extrabold tracking-[-0.04em] text-txt-hi" style={{ fontSize: size * 0.62 }}>Murlan</span>
        {!compact && <span className="brand-pill mt-1">CRYPTO</span>}
      </span>
    </span>
  );
}
