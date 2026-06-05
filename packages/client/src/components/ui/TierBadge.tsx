// Rank-tier badge: emoji + Albanian tier name in the tier's colour. Used on the
// ranked leaderboard, profile card, and anywhere a player's tier is shown.
import type { TierInfo } from '../../lib/api.ts';

interface TierBadgeProps {
  tier: TierInfo;
  size?: 'sm' | 'md' | 'lg';
  showName?: boolean;
  className?: string;
}

const SIZES = {
  sm: { pad: 'px-2 py-0.5 text-[11px]', emoji: 'text-sm' },
  md: { pad: 'px-2.5 py-1 text-xs', emoji: 'text-base' },
  lg: { pad: 'px-3 py-1.5 text-sm', emoji: 'text-lg' },
} as const;

export function TierBadge({ tier, size = 'md', showName = true, className = '' }: TierBadgeProps) {
  const s = SIZES[size];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-display font-semibold tracking-wide ${s.pad} ${className}`}
      style={{ color: tier.color, borderColor: `${tier.color}66`, background: `${tier.color}1a` }}
      title={tier.name}
    >
      <span className={s.emoji} aria-hidden>{tier.emoji}</span>
      {showName && <span>{tier.name}</span>}
    </span>
  );
}
