// ============================================================================
// MURLAN — Socket handshake throttle + read cache
// ----------------------------------------------------------------------------
// Connection-flood defense for the Socket.IO handshake, extracted from the
// gateway god-object (audit ARCH-1/M5) as a self-contained, unit-testable unit —
// it has NO coupling to match/money/timer state, so lifting it out is behavior-
// preserving and shrinks the gateway's mutable surface.
//
// (1) `resolve` caches the per-user handshake reads (revocation-aware account-state
//     gate + avatar) for a short TTL so a connect-burst doesn't issue two DB reads
//     per socket. The cache is bypassed when the presented token's `ver` differs
//     from the cached one, so a freshly-revoked (ver-bumped) token is never accepted
//     on a stale cached OK.
// (2) `allow` is a per-(userId+IP) fixed-window connection-rate guard that rejects an
//     abusive reconnect storm.
// ============================================================================

export interface HandshakeResult {
  allowed: boolean;
  code?: string;
  avatar: string | null;
}

export class HandshakeThrottle {
  private readonly rate = new Map<string, { count: number; windowStart: number }>();
  private readonly cache = new Map<string, { at: number; ver: number; allowed: boolean; code?: string; avatar: string | null }>();

  constructor(
    private readonly cacheMs = 3_000, // re-read account-state/profile at most ~every 3s/user
    private readonly maxPerWindow = 30, // connections per (userId+IP) per window
    private readonly windowMs = 10_000, // 10s window
    private readonly maxEntries = 10_000, // opportunistic-prune ceiling per map
  ) {}

  /** Per-(userId+IP) fixed-window connection-rate guard. Returns false when over cap. */
  allow(key: string): boolean {
    const now = Date.now();
    const rec = this.rate.get(key);
    if (!rec || now - rec.windowStart >= this.windowMs) {
      this.rate.set(key, { count: 1, windowStart: now });
      // Opportunistic prune so the map can't grow without bound under an IP/user spray.
      if (this.rate.size > this.maxEntries) {
        for (const [k, v] of this.rate) if (now - v.windowStart >= this.windowMs) this.rate.delete(k);
      }
      return true;
    }
    rec.count += 1;
    return rec.count <= this.maxPerWindow;
  }

  /** TTL-cached per-user handshake read. `fetch` performs the real (DB) resolve on a cache
   *  miss or when the token's `ver` changed (revocation) — never serving a stale OK. */
  async resolve(userId: string, ver: number, fetch: () => Promise<HandshakeResult>): Promise<HandshakeResult> {
    const cached = this.cache.get(userId);
    if (cached && cached.ver === ver && Date.now() - cached.at < this.cacheMs) {
      return { allowed: cached.allowed, code: cached.code, avatar: cached.avatar };
    }
    const res = await fetch();
    this.cache.set(userId, { at: Date.now(), ver, allowed: res.allowed, code: res.code, avatar: res.avatar });
    if (this.cache.size > this.maxEntries) {
      const cutoff = Date.now() - this.cacheMs;
      for (const [k, v] of this.cache) if (v.at < cutoff) this.cache.delete(k);
    }
    return res;
  }
}
