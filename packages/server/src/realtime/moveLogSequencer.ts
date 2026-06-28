// ============================================================================
// MURLAN — MoveLogSequencer
// ----------------------------------------------------------------------------
// Per-match monotonic move-log sequence counter, lifted out of the gateway (audit
// 2026-06-28), mirroring the M5 registries. `next(matchId)` is assigned synchronously
// so replay/dispute ordering is correct regardless of async write timing; `drop`
// releases the counter when a match finalizes. Pure in-process bookkeeping — no I/O.
// ============================================================================

export class MoveLogSequencer {
  private readonly seq = new Map<string, number>();

  /** Return the next sequence number for this match (0, 1, 2, …) and advance it. */
  next(matchId: string): number {
    const n = this.seq.get(matchId) ?? 0;
    this.seq.set(matchId, n + 1);
    return n;
  }

  /** Drop a finished match's counter (called when the match finalizes). */
  drop(matchId: string): void {
    this.seq.delete(matchId);
  }
}
