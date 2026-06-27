// ============================================================================
// MURLAN — Rematch offer state
// ----------------------------------------------------------------------------
// Extracted from the gateway god-object (audit M5/ARCH-1). Owns ONLY the per-room
// rematch-offer bookkeeping (who accepted + the expiry deadline + its timer). The
// business logic — bot auto-accept, "everyone opted in → reset + ready + countdown",
// and the socket emits — stays in the gateway (it needs rooms/io). Behavior-preserving:
// the gateway keeps its rematch methods, delegating the state ops here.
// ============================================================================

export interface RematchOffer {
  users: Set<string>; // userIds (incl. bots) that have accepted
  deadline: number; // epoch ms when the offer lapses
}

export class RematchCoordinator {
  private readonly offers = new Map<string, RematchOffer>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  has(roomId: string): boolean {
    return this.offers.has(roomId);
  }

  get(roomId: string): RematchOffer | undefined {
    return this.offers.get(roomId);
  }

  /** Open a new offer (seeded with any pre-accepted ids, e.g. bots) + arm its expiry timer.
   *  Returns the live offer object (the caller adds the human accepter to `users`). */
  open(roomId: string, windowMs: number, seedAccepts: readonly string[], onTimeout: () => void): RematchOffer {
    const offer: RematchOffer = { users: new Set(seedAccepts), deadline: Date.now() + windowMs };
    this.offers.set(roomId, offer);
    this.timers.set(roomId, setTimeout(onTimeout, windowMs));
    return offer;
  }

  /** Drop the offer + clear its timer (on success, cancel, timeout, or room teardown). Idempotent. */
  clear(roomId: string): void {
    const t = this.timers.get(roomId);
    if (t) { clearTimeout(t); this.timers.delete(roomId); }
    this.offers.delete(roomId);
  }
}
