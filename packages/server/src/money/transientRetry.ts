// ============================================================================
// MURLAN — transient-retry for external-API READS (WEB-7)
// ----------------------------------------------------------------------------
// The free TronGrid tier and Binance both rate-limit (429) and occasionally 5xx.
// A single blip would make a poller/reconciler "go blind" for that cycle. This
// retries a fetch ONLY on a TRANSIENT failure (a network throw, HTTP 429, or 5xx);
// a definite answer (2xx, or a 4xx like 404/400 — a real "not found"/"bad request")
// returns immediately and is NOT retried.
//
// ⚠️ Use for READS ONLY — never for a payout SEND. Retrying an ambiguous send
// response risks a DOUBLE-PAY (even with provider-side idempotency, the local
// response handling can misattribute). Payout providers keep their single-shot path.
// ============================================================================

/** Minimal response shape the retry decision needs (ok + HTTP status). */
type RetriableResponse = { ok: boolean; status: number };

export interface TransientRetryOpts {
  attempts?: number; // total tries (default 3)
  baseMs?: number;   // linear backoff base: baseMs, 2*baseMs, … (default 400; pass 0 in tests)
}

/**
 * Call `fetchFn(url, init)`, retrying on transient failure. Returns the first
 * definite response. Throws the last error only after exhausting `attempts` (so a
 * caller's try/catch can degrade gracefully — e.g. return [] / null for that cycle).
 */
export async function fetchWithRetry<R extends RetriableResponse, I>(
  fetchFn: (url: string, init?: I) => Promise<R>,
  url: string,
  init?: I,
  opts: TransientRetryOpts = {},
): Promise<R> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 400;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchFn(url, init);
      // 429 (rate-limited) or 5xx (server-side) → transient; anything else is final.
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err; // network throw — retry
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
  }
  throw lastErr ?? new Error('fetchWithRetry: unreachable');
}
