import { create } from 'zustand';
import { sound } from '../lib/sound.ts';

// Device-local audio preferences. Persisted to localStorage (the real app would
// also mirror these to a per-user settings record server-side).
const KEY = 'murlan.settings.v1';

interface Persisted {
  muted: boolean;
  volume: number; // 0..1
  musicOn: boolean;
  realityCheckMinutes: number; // responsible-gaming session reminder; 0 = off
}

const RC_ALLOWED = [0, 15, 30, 60];
const normRc = (v: unknown): number => (typeof v === 'number' && RC_ALLOWED.includes(v) ? v : 30);

function load(): Persisted {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>;
      return {
        muted: !!p.muted,
        volume: typeof p.volume === 'number' ? Math.max(0, Math.min(1, p.volume)) : 0.6,
        musicOn: !!p.musicOn,
        realityCheckMinutes: normRc(p.realityCheckMinutes),
      };
    }
  } catch { /* ignore */ }
  return { muted: false, volume: 0.6, musicOn: false, realityCheckMinutes: 30 };
}

const initial = load();
// Push the loaded prefs into the audio engine up front. (Music nodes are queued
// on a suspended context and begin once the first user gesture unlocks audio.)
sound.setMuted(initial.muted);
sound.setVolume(initial.volume);
if (initial.musicOn && !initial.muted) sound.startMusic();

interface SettingsStore extends Persisted {
  setMuted: (m: boolean) => void;
  setVolume: (v: number) => void;
  setMusicOn: (on: boolean) => void;
  setRealityCheckMinutes: (m: number) => void;
}

function persist(s: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ muted: s.muted, volume: s.volume, musicOn: s.musicOn, realityCheckMinutes: s.realityCheckMinutes }));
  } catch { /* ignore */ }
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...initial,

  setMuted(muted) {
    sound.setMuted(muted);
    if (muted) sound.stopMusic();
    else if (get().musicOn) sound.startMusic();
    set({ muted });
    persist({ ...get(), muted });
  },
  setVolume(volume) {
    const v = Math.max(0, Math.min(1, volume));
    sound.setVolume(v);
    set({ volume: v });
    persist({ ...get(), volume: v });
  },
  setMusicOn(musicOn) {
    if (musicOn && !get().muted) sound.startMusic();
    else sound.stopMusic();
    set({ musicOn });
    persist({ ...get(), musicOn });
  },
  setRealityCheckMinutes(realityCheckMinutes) {
    const m = normRc(realityCheckMinutes);
    set({ realityCheckMinutes: m });
    persist({ ...get(), realityCheckMinutes: m });
  },
}));
