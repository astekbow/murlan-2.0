// ============================================================================
// MURLAN — Provably-fair seed state
// ----------------------------------------------------------------------------
// Extracted from the gateway god-object (audit M5/ARCH-1). Owns ONLY the three
// provably-fair seed maps and their lifecycle transitions — NO crypto and NO socket
// emits (the gateway keeps generateServerSeed/combineClientSeeds/createFairShuffle and
// every fair:commit/fair:reveal emit). This is a behavior-preserving STATE lift, kept
// deliberately thin because the flow is settlement-critical:
//   countdown → commitServerSeed (fix the seed BEFORE clients submit)
//   clients submit → recordClientSeed (post-commit entropy)
//   deal        → recordDeal (store the live shuffle, consume the pending seed)
//   match end   → shuffle()+clearShuffle (reveal then drop)
// Seeds are dropped between matches (dropClientSeed on disconnect/new commit;
// abandonServerSeed on an unused countdown) so a stale seed never bleeds into the next.
// ============================================================================

import type { FairShuffle } from '../fair/provablyFair.ts';

export class FairnessCoordinator {
  private readonly byRoom = new Map<string, FairShuffle>(); // live shuffle per active match (for reveal)
  private readonly pendingSeeds = new Map<string, string>(); // roomId → serverSeed committed at countdown
  private readonly clientSeeds = new Map<string, string>(); // userId → clientSeed submitted AFTER the commit

  // --- client entropy (submitted during the countdown, after the commit) ---------
  recordClientSeed(userId: string, seed: string): void {
    this.clientSeeds.set(userId, seed);
  }
  /** Drop a user's seed so it can't bleed into a future match (disconnect / pre-commit clear). */
  dropClientSeed(userId: string): void {
    this.clientSeeds.delete(userId);
  }
  clientSeed(userId: string): string | undefined {
    return this.clientSeeds.get(userId);
  }

  // --- committed server seed (fixed at countdown start, BEFORE any client seed) ---
  commitServerSeed(roomId: string, serverSeed: string): void {
    this.pendingSeeds.set(roomId, serverSeed);
  }
  pendingServerSeed(roomId: string): string | undefined {
    return this.pendingSeeds.get(roomId);
  }
  /** Discard a committed-but-unused seed (a countdown that never dealt). */
  abandonServerSeed(roomId: string): void {
    this.pendingSeeds.delete(roomId);
  }

  // --- the live shuffle (created at deal, consumed at reveal) ---------------------
  /** Store the dealt shuffle for later reveal + consume the now-used pending seed (one step,
   *  as the gateway always did them together). */
  recordDeal(roomId: string, fair: FairShuffle): void {
    this.byRoom.set(roomId, fair);
    this.pendingSeeds.delete(roomId);
  }
  shuffle(roomId: string): FairShuffle | undefined {
    return this.byRoom.get(roomId);
  }
  clearShuffle(roomId: string): void {
    this.byRoom.delete(roomId);
  }
}
