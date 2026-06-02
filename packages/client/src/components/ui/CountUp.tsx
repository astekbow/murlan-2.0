import { useEffect, useRef, useState } from 'react';
import { dollars } from '../../lib/money.ts';

const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Animated USD amount that counts up/down to `valueCents` when it changes. */
export function CountUp({ valueCents, className, durationMs = 650 }: { valueCents: number; className?: string; durationMs?: number }) {
  const [display, setDisplay] = useState(valueCents);
  const fromRef = useRef(valueCents);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = valueCents;
    if (from === to) return;
    if (prefersReduced()) { setDisplay(to); fromRef.current = to; return; }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [valueCents, durationMs]);

  return <span className={className}>{dollars(display)}</span>;
}
