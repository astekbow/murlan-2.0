// Token-bucket rate limiter for socket events (anti-cheat / anti-abuse, spec §9).
// One bucket per key (the gateway keys by USER id, so a user can't bypass the
// limit by opening several sockets): `capacity` burst, refilled at `refillPerSec`.

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Consume `cost` tokens for `key`; returns false (and consumes nothing) if empty. */
  allow(key: string, cost = 1): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: t };
      this.buckets.set(key, b);
    }
    const elapsedSec = Math.max(0, (t - b.last) / 1000);
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  release(key: string): void {
    this.buckets.delete(key);
  }
}
