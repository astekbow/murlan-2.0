let lastSent = 0;

/** Fire-and-forget: report an uncaught client error to the server log (no third
 *  party). Never throws, and throttled so an error loop can't flood the endpoint. */
export function logClientError(message: string, detail?: { stack?: string; url?: string; kind?: string }): void {
  try {
    const now = performance.now();
    if (now - lastSent < 4000) return; // ~1 report / 4s max
    lastSent = now;
    const payload = JSON.stringify({
      message: String(message ?? '').slice(0, 500),
      stack: detail?.stack?.slice(0, 2000),
      url: detail?.url ?? location.href,
      kind: detail?.kind,
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/client-errors', new Blob([payload], { type: 'application/json' }));
    } else {
      void fetch('/api/client-errors', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* the logger must never throw */
  }
}

/** Install global handlers for uncaught errors + unhandled promise rejections. */
export function installGlobalErrorLogging(): void {
  window.addEventListener('error', (e) => {
    logClientError(e.message || 'window error', { stack: (e.error as Error | undefined)?.stack, kind: 'error' });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | undefined;
    logClientError(reason?.message ?? String(e.reason), { stack: reason?.stack, kind: 'unhandledrejection' });
  });
}
