// Tiny session-clock store: stamps when the current play session began (login /
// bootstrap) so the TopBar can show a subtle "Po luan: 42m" indicator. This is a
// responsible-gaming nudge — purely presentational, never touches money/game state.
//
// `start()` is idempotent: it only stamps the FIRST time after a clear, so a token
// refresh or a re-render doesn't reset the clock mid-session. `clear()` is called
// on logout so a new user on the same tab starts fresh.

import { create } from 'zustand';
import { useEffect, useState } from 'react';

interface SessionStore {
  /** Epoch ms when this session began, or null when signed out. */
  startedAt: number | null;
  /** Stamp the start time once (no-op if already running). */
  start: () => void;
  /** Reset the clock (on logout). */
  clear: () => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  startedAt: null,
  start() {
    if (get().startedAt == null) set({ startedAt: Date.now() });
  },
  clear() {
    set({ startedAt: null });
  },
}));

/** Whole minutes elapsed since the session began (0 when not started). */
export function elapsedMinutes(startedAt: number | null, now: number = Date.now()): number {
  if (startedAt == null) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 60000));
}

/** Compact duration label: "42m" under an hour, "1h 5m" beyond. */
export function formatSessionDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

/**
 * Reactive elapsed-minutes hook that re-renders ~once a minute (aligned to the
 * next minute boundary so the figure flips promptly, then every 60s). Returns 0
 * until the session has been started.
 */
export function useSessionMinutes(): number {
  const startedAt = useSessionStore((s) => s.startedAt);
  const [minutes, setMinutes] = useState(() => elapsedMinutes(startedAt));

  useEffect(() => {
    if (startedAt == null) {
      setMinutes(0);
      return;
    }
    setMinutes(elapsedMinutes(startedAt));
    // Fire on the next whole-minute boundary, then settle into a 60s cadence.
    const msToNextMinute = 60000 - ((Date.now() - startedAt) % 60000);
    let interval: ReturnType<typeof setInterval> | null = null;
    const timeout = setTimeout(() => {
      setMinutes(elapsedMinutes(startedAt));
      interval = setInterval(() => setMinutes(elapsedMinutes(startedAt)), 60000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [startedAt]);

  return minutes;
}
