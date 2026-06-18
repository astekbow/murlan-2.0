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
    // All SFX kept SOFT + musical: sine/triangle only (no harsh square clicks), mid-range
    // pitches (no shrill highs), gentle peaks — pleasant on every tap, not fatiguing.
    switch (name) {
      case 'card': tone(523.25, t, 0.07, 'sine', 0.15); tone(392, t, 0.05, 'sine', 0.07); break;     // soft card place (C5 + G4)
      case 'select': tone(784, t, 0.05, 'sine', 0.1); break;                                          // gentle pluck (G5)
      case 'pass': tone(330, t, 0.12, 'sine', 0.15); tone(246.94, t + 0.07, 0.15, 'sine', 0.12); break; // soft descend (E4→B3)
      case 'turn': tone(587.33, t, 0.16, 'sine', 0.17); tone(880, t + 0.1, 0.24, 'sine', 0.13); break;  // gentle rising chime (D5→A5)
      case 'button': tone(440, t, 0.045, 'sine', 0.06); break;                                         // soft, quiet tick (A4)
      case 'deal': for (let i = 0; i < 5; i++) noise(t + i * 0.045, 0.05, 0.13, 2200); break;           // softer shuffle
      case 'win': [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.11, 0.3, 'sine', 0.22)); break; // warm major arpeggio
      case 'lose': tone(440, t, 0.22, 'sine', 0.17); tone(311.13, t + 0.13, 0.32, 'sine', 0.17); break; // soft descend
      // A bomb (four-of-a-kind) landing: a sub-bass thump + a low rumble + a crack (kept impactful).
      case 'bomb': tone(70, t, 0.45, 'sine', 0.48); noise(t, 0.4, 0.4, 700); tone(160, t, 0.18, 'sawtooth', 0.2); break;
      // Money credited (deposit / winnings): a gentle bright rising chime (A5→E6→A6).
      case 'coin': tone(880, t, 0.1, 'sine', 0.18); tone(1318.5, t + 0.07, 0.16, 'sine', 0.13); tone(1760, t + 0.14, 0.2, 'sine', 0.08); break;
      // Turn running out (≤5s): a soft two-note "ding-ding" — noticeable but not harsh.
      case 'warn': tone(659.25, t, 0.11, 'triangle', 0.17); tone(523.25, t + 0.16, 0.14, 'triangle', 0.15); break;
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
