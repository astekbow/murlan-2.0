// ============================================================================
// MURLAN — Spectator counts per room
// ----------------------------------------------------------------------------
// Extracted from the gateway god-object (audit M5/ARCH-1). Pure count bookkeeping
// with a cap — NO coupling to settlement, timers, match state, or the io socket
// (the socket join/leave + the broadcast stay in the gateway). Behavior-preserving:
// the gateway keeps its spectate methods as thin delegators. Unit-testable in isolation.
// ============================================================================

export class SpectatorRegistry {
  // roomId → (spectator key (socket id) → username). The map size IS the count; tracking the keyed
  // usernames lets the gateway broadcast a "who's watching" list, not just a tally.
  private readonly rooms = new Map<string, Map<string, string>>();

  constructor(private readonly cap: number = 100) {}

  /** True when the room is already at the spectator cap (reject further watchers). */
  isFull(roomId: string): boolean {
    return (this.rooms.get(roomId)?.size ?? 0) >= this.cap;
  }

  /** Add (or refresh) a spectator for the room, keyed by a stable id (the socket id). */
  add(roomId: string, key: string, name: string): void {
    let m = this.rooms.get(roomId);
    if (!m) { m = new Map(); this.rooms.set(roomId, m); }
    m.set(key, name);
  }

  /** Drop one spectator by key; removes the room entry entirely at zero. */
  remove(roomId: string, key: string): void {
    const m = this.rooms.get(roomId);
    if (!m) return;
    m.delete(key);
    if (m.size === 0) this.rooms.delete(roomId);
  }

  /** Current spectator tally for the room (0 if none). */
  count(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  /** The usernames currently watching the room (insertion order; empty if none). */
  names(roomId: string): string[] {
    return [...(this.rooms.get(roomId)?.values() ?? [])];
  }

  /** Forget the room entirely (called on room teardown). */
  clear(roomId: string): void {
    this.rooms.delete(roomId);
  }
}
