import { memo } from 'react';
import { useT } from '../lib/i18n.ts';

interface SeatBadgeProps {
  name: string;
  count: number;
  team: 0 | 1 | null;
  isTurn: boolean;
  connected: boolean;
  finished: boolean;
  passed: boolean;
  lastPlayer?: boolean; // led the current pile
  partner?: boolean;    // 2v2 teammate of the local player
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s_]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? name[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/**
 * Opponent indicator: avatar with a status ring (gold = their turn, green =
 * last led, blue = idle), name, a face-down mini fan, and the card COUNT.
 * The fan is decorative and capped — opponents' card IDENTITIES are NEVER shown
 * (the server only ever sends counts), only how many they hold.
 */
function SeatBadgeImpl({ name, count, team, isTurn, connected, finished, passed, lastPlayer, partner }: SeatBadgeProps) {
  const t = useT();
  const ring = isTurn ? 'turn' : lastPlayer ? 'green' : '';
  const fanCount = Math.min(Math.max(count, 0), 8); // visual cap; the number is the truth
  const status = finished ? t('seat.finished') : passed ? t('seat.passed') : !connected ? t('seat.offline') : isTurn ? t('seat.turn') : '';

  return (
    <div className={`flex flex-col items-center gap-1 ${!connected ? 'opacity-60' : ''}`}>
      <div className="flex h-5 items-end" aria-hidden="true">
        {Array.from({ length: fanCount }).map((_, i) => (
          <div key={i} className="mini" style={{ height: 22, width: 16, marginLeft: i === 0 ? 0 : -9 }} />
        ))}
      </div>
      <div className={`av ${ring} ${!connected ? 'off' : ''}`} title={name}>{initials(name)}</div>
      <div className={`seat-nm ${partner ? 'partner' : ''} truncate max-w-[110px]`}>
        {name}{partner && ` · ${t('seat.partner')}`}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="seat-cnt">({count})</span>
        {lastPlayer && <span className="lastp">{t('seat.ledLast')}</span>}
        {team !== null && !partner && <span className="text-[11px] text-cream/80">{t('seat.team', { n: team + 1 })}</span>}
      </div>
      {status && <div className="text-[11px] text-cream/80 h-3.5 leading-tight">{status}</div>}
    </div>
  );
}

// Memoized: opponents' seats only re-render when their own props change (count,
// turn, connection…), not on every unrelated table state update.
export const SeatBadge = memo(SeatBadgeImpl);
