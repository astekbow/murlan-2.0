import { useEffect, useState } from 'react';
import { useT } from '../../lib/i18n.ts';

/** ms until the next UTC midnight — when daily rewards + the daily deal reset (server resets on the
 *  UTC-day boundary, verified in rewardsService.test.ts). */
function msToNextUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(0, next - now.getTime());
}

/** A live "resets in Xh Ym" label so a "claimed today" / daily-deal state answers the obvious
 *  question (when does it come back?) instead of being a dead end. Ticks each half-minute. */
export function ResetCountdown({ className, prefixKey = 'common.resetsIn' }: { className?: string; prefixKey?: string }) {
  const t = useT();
  const [ms, setMs] = useState(msToNextUtcMidnight());
  useEffect(() => {
    const id = setInterval(() => setMs(msToNextUtcMidnight()), 30_000);
    return () => clearInterval(id);
  }, []);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return <span className={className}>{t(prefixKey, { time: h > 0 ? `${h}h ${m}m` : `${m}m` })}</span>;
}
