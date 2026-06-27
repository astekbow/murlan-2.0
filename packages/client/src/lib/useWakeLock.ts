import { useEffect } from 'react';

/**
 * Keep the phone screen awake while `active` is true (e.g. the whole time the player is at the game
 * table), via the Screen Wake Lock API. Without this the screen auto-sleeps mid-game on a phone.
 *
 * - Silent no-op where the API is unsupported (older browsers) or the request is denied.
 * - The OS auto-RELEASES a wake lock whenever the page is hidden (backgrounded / screen off), so we
 *   re-acquire it on visibilitychange → visible. Released on unmount / when `active` goes false.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }) : null;
    if (!active || !nav?.wakeLock) return;

    let sentinel: { release(): Promise<void> } | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        sentinel = await nav.wakeLock!.request('screen');
      } catch {
        /* denied / unsupported / a system lock (e.g. low battery) — benign, just no keep-awake */
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
