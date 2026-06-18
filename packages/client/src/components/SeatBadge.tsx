import { memo } from 'react';
import { useT } from '../lib/i18n.ts';
import { AvatarFace } from './ui/AvatarFace.tsx';

interface SeatBadgeProps {
  name: string;
  count: number;
  team: 0 | 1 | null;
  isTurn: boolean;
  connected: boolean;
  finished: boolean;
  passed: boolean;
  avatar?: string | null; // cosmetic avatar (preset id or data URL); null → show initials
  lastPlayer?: boolean; // led the current pile
  partner?: boolean;    // 2v2 teammate of the local player
  turnDeadline?: number | null; // epoch ms — when set + isTurn, a depleting ring shows the time left
  placement?: string;   // seat position ('top' gets a compact layout that hugs the avatar)
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s_]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? name[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** A ring around the avatar that depletes over the remaining turn time. Restarts
 *  whenever the deadline changes (a new turn). Pure CSS animation — cheap, no timers. */
function TurnRing({ deadline }: { deadline: number }) {
  const remaining = Math.max(0, deadline - Date.now());
  return (
    <svg className="turn-ring" viewBox="0 0 40 40" aria-hidden>
      <circle
        className="turn-ring-track" cx="20" cy="20" r="18" pathLength={100}
      />
      <circle
        key={deadline} // restart the animation on each new turn
        className="turn-ring-arc" cx="20" cy="20" r="18" pathLength={100}
        style={{ animationDuration: `${remaining}ms` }}
      />
    </svg>
  );
}

/**
 * Opponent indicator: avatar with a status ring (gold = their turn, green =
 * last led, blue = idle), name, a face-down mini fan, and the card COUNT.
 * The fan is decorative and capped — opponents' card IDENTITIES are NEVER shown
 * (the server only ever sends counts), only how many they hold.
 */
function SeatBadgeImpl({ name, count, team, isTurn, connected, finished, passed, avatar, lastPlayer, partner, turnDeadline, placement }: SeatBadgeProps) {
  const t = useT();
  const ring = isTurn ? 'turn' : lastPlayer ? 'green' : '';
  const fanCount = Math.min(Math.max(count, 0), 8); // visual cap; the number is the truth
  const status = finished ? t('seat.finished') : passed ? t('seat.passed') : !connected ? t('seat.offline') : isTurn ? t('seat.turn') : '';

  const fan = (
    <div className="flex h-5 items-end" aria-hidden="true">
      {Array.from({ length: fanCount }).map((_, i) => (
        <div key={i} className="mini" style={{ height: 22, width: 16, marginLeft: i === 0 ? 0 : -9 }} />
      ))}
    </div>
  );
  const avatarEl = (
    <div className="relative inline-grid place-items-center">
      {isTurn && turnDeadline != null && <TurnRing deadline={turnDeadline} />}
      <div className={`av ${ring} ${!connected ? 'off' : ''}`} title={name}>
        {avatar ? <AvatarFace id={avatar} fill className="text-2xl leading-none" /> : initials(name)}
      </div>
    </div>
  );
  const nameEl = (
    <div className={`seat-nm ${partner ? 'partner' : ''} truncate max-w-[110px]`}>
      {name}{partner && ` · ${t('seat.partner')}`}
    </div>
  );
  const teamEl = team !== null && !partner ? <span className="text-[11px] text-cream/80">{t('seat.team', { n: team + 1 })}</span> : null;

  // TOP seat: a COMPACT layout that hugs the avatar — the card-fan + count sit together
  // at the very top, the name tucks right under the avatar, and the "led last" badge goes
  // to the SIDE (absolute) — so nothing hangs down over the felt / pile.
  if (placement === 'top') {
    return (
      <div className={`relative flex flex-col items-center gap-0.5 ${!connected ? 'opacity-60' : ''}`}>
        <div className="flex items-center gap-1.5">
          {fan}
          <span className="seat-cnt">({count})</span>
          {teamEl}
        </div>
        {avatarEl}
        {nameEl}
        {lastPlayer && <span className="lastp absolute left-full top-1/2 -translate-y-1/2 ml-1.5 whitespace-nowrap">{t('seat.ledLast')}</span>}
        {status && <div className="text-[11px] text-cream/80 leading-tight">{status}</div>}
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center gap-1 ${!connected ? 'opacity-60' : ''}`}>
      {fan}
      {avatarEl}
      {nameEl}
      <div className="flex items-center gap-1.5">
        <span className="seat-cnt">({count})</span>
        {lastPlayer && <span className="lastp">{t('seat.ledLast')}</span>}
        {teamEl}
      </div>
      {status && <div className="text-[11px] text-cream/80 h-3.5 leading-tight">{status}</div>}
    </div>
  );
}

// Memoized: opponents' seats only re-render when their own props change (count,
// turn, connection…), not on every unrelated table state update.
export const SeatBadge = memo(SeatBadgeImpl);
