// ============================================================================
// MURLAN — Spectator counts per room
// ----------------------------------------------------------------------------
// Extracted from the gateway god-object (audit M5/ARCH-1). Pure count bookkeeping
// with a cap — NO coupling to settlement, timers, match state, or the io socket
// (the socket join/leave + the broadcast stay in the gateway). Behavior-preserving:
// the gateway keeps its spectate methods as thin delegators. Unit-testable in isolation.
// ============================================================================

export class SpectatorRegistry {
  private readonly counts = new Map<string, number>();

  constructor(private readonly cap: number = 100) {}

  /** True when the room is already at the spectator cap (reject further watchers). */
  isFull(roomId: string): boolean {
    return (this.counts.get(roomId) ?? 0) >= this.cap;
  }

  /** Count a new spectator for the room. */
  add(roomId: string): void {
    this.counts.set(roomId, (this.counts.get(roomId) ?? 0) + 1);
  }

  /** Drop one spectator; removes the entry entirely at zero. */
  remove(roomId: string): void {
    const n = (this.counts.get(roomId) ?? 1) - 1;
    if (n <= 0) this.counts.delete(roomId);
    else this.counts.set(roomId, n);
  }

  /** Current spectator tally for the room (0 if none). */
  count(roomId: string): number {
    return this.counts.get(roomId) ?? 0;
  }

  /** Forget the room entirely (called on room teardown). */
  clear(roomId: string): void {
    this.counts.delete(roomId);
  }
}
