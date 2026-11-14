import { useEffect, useState } from 'react';
import { Icon } from './ui/Icon.tsx';

/** Counts down to the current turn's deadline (epoch ms from the server). Amber chip (time is a
 *  "watch this" signal, not an action); the last 5 seconds turn it red — with the number, so the
 *  urgency is never colour-only. */
export function TurnTimer({ deadline }: { deadline: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [deadline]);

  if (deadline === null) return null;
  const remainingMs = Math.max(0, deadline - now);
  const secs = Math.ceil(remainingMs / 1000);
  const low = secs <= 5;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full min-h-[34px] px-3 text-[13px] font-extrabold tabular-nums ${
        low ? 'text-white bg-[#C93838]' : 'text-amber-ink bg-amber'
      }`}
    >
      <Icon name="clock" size={15} stroke={2.4} />
      {secs}s
    </span>
  );
}
