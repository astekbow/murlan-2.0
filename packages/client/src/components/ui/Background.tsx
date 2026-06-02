// Fixed atmospheric backdrop behind every screen: faint tiled suit watermark,
// grain, vignette, and a few twinkling sparkles. Purely decorative; sits at
// z-0 with pointer-events disabled so it never intercepts taps.

const SPARKS = [
  { top: '18%', left: '22%', delay: '0s' },
  { top: '30%', left: '70%', delay: '1s' },
  { top: '62%', left: '14%', delay: '.5s' },
  { top: '74%', left: '80%', delay: '1.5s' },
  { top: '46%', left: '48%', delay: '2.2s' },
];

export function Background() {
  return (
    <div className="bgfx" aria-hidden="true">
      <div className="suits" />
      <div className="grain" />
      <div className="vig" />
      {SPARKS.map((s, i) => (
        <div key={i} className="spark" style={{ top: s.top, left: s.left, animationDelay: s.delay }} />
      ))}
    </div>
  );
}
