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
  gone?: boolean; // player abandoned the match (auto-passed, placed last) — greyed + "Larguar"
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
function SeatBadgeImpl({ name, count, team, isTurn, connected, finished, passed, gone, avatar, lastPlayer, partner, turnDeadline, placement }: SeatBadgeProps) {
  const t = useT();
  const ring = isTurn ? 'turn' : lastPlayer ? 'green' : '';
  const fanCount = Math.min(Math.max(count, 0), 8); // visual cap; the number is the truth
  // A player who abandoned the match takes priority over every other status — the
  // seat plays on auto-passed (placed last), so show it greyed with a clear label.
  const dimmed = gone || !connected;
  const status = gone ? t('seat.left') : finished ? t('seat.finished') : passed ? t('seat.passed') : !connected ? t('seat.offline') : isTurn ? t('seat.turn') : '';

  // Side seats: a VERTICAL fan of cards held facing the TABLE — so it peeks out the table-side
  // edge of the avatar (left-side seats lean right toward centre, right-side seats lean left),
  // BEHIND the avatar. Top/bottom seats keep the horizontal fan in the row above the avatar.
  const leftSide = placement === 'left' || placement === 'top-left';
  const rightSide = placement === 'right' || placement === 'top-right';
  const side = leftSide || rightSide;
  const fan = (
    <div className="flex h-5 items-end" aria-hidden="true">
      {Array.from({ length: fanCount }).map((_, i) => (
        <div key={i} className="mini" style={{ height: 22, width: 16, marginLeft: i === 0 ? 0 : -9 }} />
      ))}
    </div>
  );
  // Vertical, table-facing fan tucked behind the avatar. Size/overlap come from CSS
  // (.seat-fan-behind .mini) so it scales with the table; the side class sets the lean.
  const behindFan = (
    <div className={`seat-fan-behind ${leftSide ? 'tbl-left' : 'tbl-right'}`} aria-hidden="true">
      {Array.from({ length: fanCount }).map((_, i) => <div key={i} className="mini" />)}
    </div>
  );
  const avatarEl = (
    <div className="relative inline-grid place-items-center isolate">
      {side && fanCount > 0 && behindFan}
      {isTurn && turnDeadline != null && <TurnRing deadline={turnDeadline} />}
      <div className={`av ${ring} ${dimmed ? 'off' : ''}`} title={name}>
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
  const top = placement === 'top';

  // Layout: the count "(N)" sits with the cards. The TOP seat faces DOWN toward the table, so its
  // avatar goes UP and the card-fan drops BELOW it (avatar → name → cards). Side seats keep only the
  // count up top (their fan is BEHIND the avatar). The "led last" badge is inline for non-top seats
  // but absolute to the SIDE for the TOP seat so it never hangs over the felt / pile.
  return (
    <div className={`relative flex flex-col items-center ${top ? 'gap-0.5' : 'gap-1'} ${dimmed ? 'opacity-60' : ''}`}>
      {!top && (
        <div className="flex items-center gap-1.5">
          {/* SIDE seats keep only the count up here — their fan is centred BEHIND the avatar. */}
          {!side && fan}
          <span className="seat-cnt">({count})</span>
        </div>
      )}
      {avatarEl}
      {nameEl}
      {top && (
        <div className="flex items-center gap-1.5">
          {fan}
          <span className="seat-cnt">({count})</span>
        </div>
      )}
      {(teamEl || (lastPlayer && !top)) && (
        <div className="flex items-center gap-1.5">
          {lastPlayer && !top && <span className="lastp">{t('seat.ledLast')}</span>}
          {teamEl}
        </div>
      )}
      {lastPlayer && top && (
        <span className="lastp absolute left-full top-1/2 -translate-y-1/2 ml-1.5 whitespace-nowrap">{t('seat.ledLast')}</span>
      )}
      {status && <div className="text-[11px] text-cream/80 leading-tight">{status}</div>}
    </div>
  );
}

// Memoized: opponents' seats only re-render when their own props change (count,
// turn, connection…), not on every unrelated table state update.
export const SeatBadge = memo(SeatBadgeImpl);
