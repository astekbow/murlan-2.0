// ============================================================================
// MURLAN — Friend activity feed (in-memory, social/cosmetic only)
// ----------------------------------------------------------------------------
// A small ring buffer of recent player activity (real-money WINS for now). The
// friends route filters it to the viewer's friends, so a player sees what their
// friends are up to ("Ardit fitoi $20"). Never touches money/game state — it is
// written from the already-settled match-end path as a best-effort side effect.
// ============================================================================

export type FeedKind = 'win';

export interface FeedEvent {
  userId: string;
  username: string;
  kind: FeedKind;
  amountCents: number; // the win's payout (real-money wins only)
  at: number;          // epoch ms
}

export class FeedService {
  private ring: FeedEvent[] = [];
  constructor(private readonly max = 300) {}

  /** Record a real-money win (newest first; bounded ring). `at` is supplied by the caller. */
  recordWin(userId: string, username: string, amountCents: number, at: number): void {
    this.ring.unshift({ userId, username, kind: 'win', amountCents, at });
    if (this.ring.length > this.max) this.ring.length = this.max;
  }

  /** Recent events whose actor is in `friendIds`, newest first, capped at `limit`. */
  forFriends(friendIds: ReadonlySet<string>, limit = 20): FeedEvent[] {
    const out: FeedEvent[] = [];
    for (const e of this.ring) {
      if (friendIds.has(e.userId)) {
        out.push(e);
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}
