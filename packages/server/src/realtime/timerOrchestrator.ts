// ============================================================================
// MURLAN — Timer orchestration
// ----------------------------------------------------------------------------
// Owns ALL of the gateway's scheduled timers (ready-check countdown, per-turn
// timer, per-user reconnection-abandon grace) and their deadlines, so the
// gateway is free of raw setTimeout/clearTimeout/Map bookkeeping. PURE timing:
// no game/money/socket logic — the gateway passes the expiry callback. Each
// `arm*` clears any existing timer for that key first (re-arm is idempotent).
// ============================================================================

type Handle = ReturnType<typeof setTimeout>;

export class TimerOrchestrator {
  // Ready-check countdown (keyed by roomId) + its absolute deadline.
  private countdowns = new Map<string, Handle>();
  private countdownDeadlines = new Map<string, number>();
  // Per-turn timer (keyed by roomId) + its absolute deadline (published to clients).
  private turnTimers = new Map<string, Handle>();
  private turnDeadlines = new Map<string, number>();
  // Reconnection-abandon grace (keyed by userId). No deadline is published.
  private abandonTimers = new Map<string, Handle>();

  // ---------- Countdown -------------------------------------------------------
  hasCountdown(roomId: string): boolean {
    return this.countdowns.has(roomId);
  }
  countdownDeadline(roomId: string): number | null {
    return this.countdownDeadlines.get(roomId) ?? null;
  }
  /** The fired timer self-cleans its entry BEFORE invoking onExpire (matching the
   *  gateway's prior inline behaviour). */
  armCountdown(roomId: string, ms: number, onExpire: () => void): void {
    this.clearCountdown(roomId);
    this.countdownDeadlines.set(roomId, Date.now() + ms);
    const handle = setTimeout(() => {
      this.countdowns.delete(roomId);
      this.countdownDeadlines.delete(roomId);
      onExpire();
    }, ms);
    this.countdowns.set(roomId, handle);
  }
  clearCountdown(roomId: string): void {
    const h = this.countdowns.get(roomId);
    if (h) {
      clearTimeout(h);
      this.countdowns.delete(roomId);
    }
    this.countdownDeadlines.delete(roomId);
  }

  // ---------- Turn ------------------------------------------------------------
  turnDeadline(roomId: string): number | null {
    return this.turnDeadlines.get(roomId) ?? null;
  }
  /** The turn timer does NOT self-clean on fire — the deadline lingers until the
   *  next armTurn/clearTurn, so a state broadcast issued during the expiry handler
   *  still carries the (now-passed) deadline, exactly as before. */
  armTurn(roomId: string, ms: number, onExpire: () => void): void {
    this.clearTurn(roomId);
    this.turnDeadlines.set(roomId, Date.now() + ms);
    this.turnTimers.set(roomId, setTimeout(onExpire, ms));
  }
  clearTurn(roomId: string): void {
    const h = this.turnTimers.get(roomId);
    if (h) clearTimeout(h);
    this.turnTimers.delete(roomId);
    this.turnDeadlines.delete(roomId);
  }

  // ---------- Abandon (reconnection grace) -----------------------------------
  armAbandon(userId: string, ms: number, onExpire: () => void): void {
    this.clearAbandon(userId);
    this.abandonTimers.set(userId, setTimeout(onExpire, ms));
  }
  clearAbandon(userId: string): void {
    const h = this.abandonTimers.get(userId);
    if (h) clearTimeout(h);
    this.abandonTimers.delete(userId);
  }

  /** Cancel everything (server shutdown) — no timer keeps the process alive. */
  clearAll(): void {
    for (const h of this.countdowns.values()) clearTimeout(h);
    for (const h of this.turnTimers.values()) clearTimeout(h);
    for (const h of this.abandonTimers.values()) clearTimeout(h);
    this.countdowns.clear();
    this.countdownDeadlines.clear();
    this.turnTimers.clear();
    this.turnDeadlines.clear();
    this.abandonTimers.clear();
  }
}
