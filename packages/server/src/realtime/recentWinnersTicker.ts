// ============================================================================
// MURLAN — RecentWinnersTicker
// ----------------------------------------------------------------------------
// The bounded, newest-first ring of recent REAL-money human winners shown on the
// lobby "live" ticker. A behavior-preserving STATE lift out of the gateway (audit
// 2026-06-28), mirroring the M5 registries (Spectator/Timer/Bot/Fairness): the
// gateway still DECIDES who counts as a real-money human winner; this owns only the
// capped buffer. Display-only — written as a read-only side effect AFTER settlement
// records the already-decided winner + already-paid amount, never an input to it.
// ============================================================================

/** One entry in the cosmetic lobby winners ticker (already-decided winner + already-paid amount). */
export interface RecentWinner {
  username: string;
  amountCents: number;
  at: number; // epoch ms — for ordering / staleness on the client
}

export class RecentWinnersTicker {
  private readonly ring: RecentWinner[] = [];

  constructor(private readonly max: number) {}

  /** Push a winner to the front, trimming the ring to `max` (newest-first). */
  add(username: string, amountCents: number, at: number): void {
    this.ring.unshift({ username, amountCents, at });
    if (this.ring.length > this.max) this.ring.length = this.max;
  }

  /** Defensive copy for the read-only lobby snapshot. */
  snapshot(): RecentWinner[] {
    return this.ring.slice();
  }
}
