// ============================================================================
// MURLAN — Tournament-bracket match state
// ----------------------------------------------------------------------------
// Extracted from the gateway god-object (audit M5/ARCH-1). Owns ONLY the bookkeeping
// for in-flight bracket pairings: (1) which pairings already have a live room (so two
// rooms are never spun up for the same `${tid}:${round}:${index}`), and (2) the per-room
// no-show join timer that walks a pairing over if a player never shows. The bracket
// LOGIC (spin-up, no-show walkover, advance/report/finish) stays in the gateway — it
// drives the TournamentService + rooms + io. Behavior-preserving state lift.
// ============================================================================

export class TournamentMatchRegistry {
  // pairingKey → live roomId. Presence dedups concurrent spin-ups of the same pairing.
  private readonly pairings = new Map<string, string>();
  // roomId → no-show walkover timer.
  private readonly noShowTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private static key(tournamentId: string, round: number, index: number): string {
    return `${tournamentId}:${round}:${index}`;
  }

  /** Already has a live room? (dedup guard before spinning up a pairing's room). */
  isRunning(tournamentId: string, round: number, index: number): boolean {
    return this.pairings.has(TournamentMatchRegistry.key(tournamentId, round, index));
  }
  markRunning(tournamentId: string, round: number, index: number, roomId: string): void {
    this.pairings.set(TournamentMatchRegistry.key(tournamentId, round, index), roomId);
  }
  clearPairing(tournamentId: string, round: number, index: number): void {
    this.pairings.delete(TournamentMatchRegistry.key(tournamentId, round, index));
  }

  /** Arm a per-room no-show timer (unref'd so it never holds the process open). */
  armNoShow(roomId: string, delayMs: number, run: () => void): void {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    this.noShowTimers.set(roomId, timer);
  }
  /** Clear a room's no-show timer (a player joined, the timer fired, or teardown). Idempotent. */
  cancelNoShow(roomId: string): void {
    const t = this.noShowTimers.get(roomId);
    if (t) { clearTimeout(t); this.noShowTimers.delete(roomId); }
  }
}
