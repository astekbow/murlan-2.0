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
  // Colours route through the design tokens (--danger / gold) — one red, one accent, app-wide —
  // instead of raw Tailwind palette values, and the final-5s red is the same --danger as
  // everywhere else (matches the deplete bar's urgency cue).
  const style = low
    ? { color: '#ffd9d9', borderColor: 'var(--danger)', background: 'rgba(255, 93, 93, 0.15)' }
    : { color: 'var(--gold-hi)', borderColor: 'var(--gold-line)', background: 'rgba(0, 0, 0, 0.3)' };
  return (
    <span
      className="tvc-timer inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-display font-semibold tabular-nums border"
      style={style}
    >
      ⏱ {secs}s
    </span>
  );
}
