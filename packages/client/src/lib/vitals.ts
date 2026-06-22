// Dependency-free Core Web Vitals capture (no Sentry, no web-vitals lib). Observes
// LCP + cumulative layout shift via PerformanceObserver and reads navigation timing
// (TTFB), then beacons a one-line summary to the EXISTING /api/client-errors sink
// (kind='web-vitals') once, when the page is hidden/unloaded. Server logs it (pino).
// Browser-only + fully feature-detected — a no-op where the APIs are missing (jsdom/SSR).

let lcp = 0;
let cls = 0;
let sent = false;

function ttfbMs(): number {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav ? Math.round(nav.responseStart) : 0;
  } catch {
    return 0;
  }
}

function beacon(): void {
  if (sent) return;
  sent = true;
  const payload = JSON.stringify({
    message: `LCP=${Math.round(lcp)}ms CLS=${cls.toFixed(3)} TTFB=${ttfbMs()}ms`,
    kind: 'web-vitals',
    url: location.pathname,
  });
  try {
    if (navigator.sendBeacon) navigator.sendBeacon('/api/client-errors', new Blob([payload], { type: 'application/json' }));
    else void fetch('/api/client-errors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true });
  } catch {
    /* telemetry must never break the app */
  }
}

export function installWebVitals(): void {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  try {
    // Largest Contentful Paint — keep the latest reported candidate.
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const lastEntry = entries[entries.length - 1] as (PerformanceEntry & { startTime: number }) | undefined;
      if (lastEntry) lcp = lastEntry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* unsupported entry type */ }
  try {
    // Cumulative Layout Shift — sum shifts not caused by recent user input.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput?: boolean }>) {
        if (!entry.hadRecentInput) cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* unsupported entry type */ }

  // Report once the page is being hidden (most reliable point to flush metrics).
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beacon(); });
  addEventListener('pagehide', beacon);
}
