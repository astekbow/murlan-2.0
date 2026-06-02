import { useMemo } from 'react';

const COLORS = ['#e6c570', '#fff1c4', '#34c46a', '#fbfaf5', '#c9a14d'];

/** A one-shot gold/green confetti burst for celebrations. Decorative, fixed
 *  overlay, pointer-events-none; auto-fades via CSS. Skipped under reduced-motion. */
export function Confetti({ count = 44 }: { count?: number }) {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        // Deterministic pseudo-random so it doesn't reshuffle on re-render.
        const r = (n: number) => ((Math.sin(i * 99.7 + n * 12.3) + 1) / 2);
        return {
          left: `${Math.round(r(1) * 100)}%`,
          delay: `${(r(2) * 0.5).toFixed(2)}s`,
          duration: `${(1.7 + r(3) * 1.3).toFixed(2)}s`,
          drift: `${Math.round((r(4) - 0.5) * 160)}px`,
          rotate: `${Math.round(r(5) * 720 - 360)}deg`,
          color: COLORS[i % COLORS.length],
          size: 6 + Math.round(r(6) * 6),
        };
      }),
    [count],
  );

  if (reduced) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[70] overflow-hidden" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            top: '-16px',
            left: p.left,
            width: p.size,
            height: p.size * 1.4,
            background: p.color,
            borderRadius: 2,
            // @ts-expect-error — custom props consumed by the keyframe
            '--drift': p.drift,
            '--rot': p.rotate,
            animation: `confettiFall ${p.duration} linear ${p.delay} forwards`,
          }}
        />
      ))}
    </div>
  );
}
