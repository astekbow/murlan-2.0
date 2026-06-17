// ============================================================================
// MURLAN — tiny sound engine (Phase 4)
// ----------------------------------------------------------------------------
// All SFX are SYNTHESISED with the Web Audio API (no asset files to ship). A
// single AudioContext is created lazily and resumed on the first user gesture
// (browsers block audio until then). Volume/mute are driven by the settings
// store. Purely presentational — touches no game/money state.
// ============================================================================

export type Sfx = 'deal' | 'card' | 'pass' | 'turn' | 'win' | 'lose' | 'button' | 'select' | 'bomb' | 'coin' | 'warn';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let volume = 0.6;

// Ambient music nodes (a soft low pad), created on demand.
let music: { osc: OscillatorNode[]; gain: GainNode; lfo: OscillatorNode } | null = null;

function ensure(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

// Resume/unlock the context on the first interactions.
if (typeof window !== 'undefined') {
  const unlock = () => { ensure(); };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, peak: number): void {
  if (!ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function noise(start: number, dur: number, peak: number, cutoff: number): void {
  if (!ctx || !master) return;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.sin(i * 12.9898) * 43758.5453) % 1; // cheap deterministic noise
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(start);
  src.stop(start + dur + 0.02);
}

export const sound = {
  setMuted(m: boolean): void {
    muted = m;
    if (master && ctx) master.gain.setTargetAtTime(m ? 0 : volume, ctx.currentTime, 0.02);
  },
  setVolume(v: number): void {
    volume = Math.max(0, Math.min(1, v));
    if (master && ctx && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  },
  play(name: Sfx): void {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    switch (name) {
      case 'card': tone(660, t, 0.08, 'triangle', 0.25); break;
      case 'select': tone(880, t, 0.06, 'triangle', 0.18); break;
      case 'pass': tone(200, t, 0.16, 'sine', 0.22); break;
      case 'turn': tone(1320, t, 0.18, 'sine', 0.22); tone(1760, t + 0.08, 0.18, 'sine', 0.16); break;
      case 'button': tone(1200, t, 0.035, 'square', 0.08); break;
      case 'deal': for (let i = 0; i < 5; i++) noise(t + i * 0.045, 0.05, 0.18, 2600); break;
      case 'win': [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.1, 0.28, 'triangle', 0.26)); break;
      case 'lose': tone(440, t, 0.22, 'sine', 0.2); tone(330, t + 0.12, 0.3, 'sine', 0.2); break;
      // A bomb (four-of-a-kind) landing: a sub-bass thump + a low rumble + a crack.
      case 'bomb': tone(70, t, 0.45, 'sine', 0.5); noise(t, 0.4, 0.45, 700); tone(160, t, 0.18, 'sawtooth', 0.22); break;
      // Money credited (deposit / winnings): a bright "ka-ching" coin sparkle.
      case 'coin': tone(1047, t, 0.12, 'triangle', 0.26); tone(1568, t + 0.06, 0.18, 'triangle', 0.22); tone(2093, t + 0.12, 0.16, 'sine', 0.14); break;
      // Turn running out (≤5s): two urgent square beeps so a missed turn never surprises.
      case 'warn': tone(880, t, 0.09, 'square', 0.2); tone(880, t + 0.16, 0.09, 'square', 0.2); break;
    }
  },
  startMusic(): void {
    const c = ensure();
    if (!c || !master || music) return;
    const gain = c.createGain();
    gain.gain.value = 0.05;
    gain.connect(master);
    const freqs = [110, 164.81, 220]; // A2 / E3 / A3 pad
    const osc = freqs.map((f) => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(gain);
      o.start();
      return o;
    });
    const lfo = c.createOscillator(); // slow shimmer on the pad gain
    const lfoGain = c.createGain();
    lfo.frequency.value = 0.08;
    lfoGain.gain.value = 0.02;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    lfo.start();
    music = { osc, gain, lfo };
  },
  stopMusic(): void {
    if (!music || !ctx) return;
    const now = ctx.currentTime;
    music.gain.gain.setTargetAtTime(0, now, 0.3);
    const m = music;
    music = null;
    window.setTimeout(() => {
      try { m.osc.forEach((o) => o.stop()); m.lfo.stop(); } catch { /* already stopped */ }
    }, 600);
  },
};
