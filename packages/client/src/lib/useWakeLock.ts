import { useEffect } from 'react';

/**
 * Keep the phone screen awake while `active` is true (e.g. the whole time the player is at the game
 * table), via the Screen Wake Lock API. Without this the screen auto-sleeps mid-game on a phone.
 *
 * - Silent no-op where the API is unsupported (older browsers) or the request is denied.
 * - The OS auto-RELEASES a wake lock whenever the page is hidden (backgrounded / screen off), so we
 *   re-acquire it on visibilitychange → visible. Released on unmount / when `active` goes false.
 */
type Sentinel = { release(): Promise<void>; addEventListener?(type: 'release', cb: () => void): void };

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } }) : null;
    if (!active || !nav?.wakeLock) return;

    let sentinel: Sentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || sentinel || document.visibilityState !== 'visible') return;
      try {
        sentinel = await nav.wakeLock!.request('screen');
        // The OS RELEASES the lock on its own (backgrounded, screen off, low battery, a system dialog).
        // Listen for that and immediately re-acquire while still active + visible — so the screen never
        // ends up sleeping mid-game once the player returns / the dialog closes.
        sentinel.addEventListener?.('release', () => { sentinel = null; if (!cancelled) void acquire(); });
      } catch {
        sentinel = null; // denied / unsupported / transient — the interval below retries
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    // Backstop: if the lock was dropped silently (some iOS builds), re-take it. The 'release' listener +
    // visibilitychange already cover the normal cases, so this only needs to be an occasional sweep.
    const retry = window.setInterval(() => { if (!sentinel) void acquire(); }, 300_000);

    return () => {
      cancelled = true;
      window.clearInterval(retry);
      document.removeEventListener('visibilitychange', onVisible);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
