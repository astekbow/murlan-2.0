import { useEffect, useState } from 'react';

/** Counts down to the current turn's deadline (epoch ms from the server). */
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
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-display font-semibold tabular-nums border ${
        low ? 'text-red-200 border-suit/60 bg-suit/15' : 'text-gold-hi border-gold/40 bg-black/30'
      }`}
    >
      ⏱ {secs}s
    </span>
  );
}
