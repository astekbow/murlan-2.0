// Fixed atmospheric backdrop behind every screen (Midnight Mint): two soft colour glows over the
// midnight ground and a whisper of grain — calm and clean, no suit watermark or sparkles competing
// with the content. Purely decorative; sits at z-0 with pointer-events disabled.

export function Background() {
  return (
    <div className="bgfx" aria-hidden="true">
      <div className="glow" />
      <div className="grain" />
    </div>
  );
}
