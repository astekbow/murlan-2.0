// ============================================================================
// MURLAN — Ranked matchmaking queue
// ----------------------------------------------------------------------------
// A per-match-type waiting pool that pairs players of similar MMR. Pure of
// sockets/timers (the gateway drives it): the gateway enqueues connected players,
// asks formGroup() whether a startable group exists, and seats the returned group
// into a fresh ranked room. FIFO-fair: the longest waiter anchors each group and
// is paired with the closest-rated compatible players within a rating bracket.
// Single-instance, in-memory (matchmaking state is ephemeral, like room state).
// ============================================================================

import type { MatchType } from '@murlan/shared';
import { PLAYERS_PER_TYPE } from '@murlan/shared';

export interface QueueEntry {
  userId: string;
  username: string;
  rating: number;
  matchType: MatchType;
  since: number; // epoch ms enqueued
}

// Generous default so games actually form for a small/new player base; with MMR
// spread it still pairs the closest-rated waiters first. Tunable later.
export const DEFAULT_TOLERANCE = 1000;

export class MatchmakingService {
  private queues = new Map<MatchType, QueueEntry[]>();
  constructor(private readonly tolerance = DEFAULT_TOLERANCE) {}

  private pool(type: MatchType): QueueEntry[] {
    let p = this.queues.get(type);
    if (!p) { p = []; this.queues.set(type, p); }
    return p;
  }

  /** Add a player (idempotent per user — re-queueing moves them to the new type). */
  enqueue(entry: QueueEntry): void {
    this.remove(entry.userId);
    this.pool(entry.matchType).push({ ...entry });
  }

  /** Remove a player from whichever queue they're in. Returns true if removed. */
  remove(userId: string): boolean {
    let removed = false;
    for (const [type, p] of this.queues) {
      const next = p.filter((e) => e.userId !== userId);
      if (next.length !== p.length) { this.queues.set(type, next); removed = true; }
    }
    return removed;
  }

  has(userId: string): boolean {
    for (const p of this.queues.values()) if (p.some((e) => e.userId === userId)) return true;
    return false;
  }

  count(type: MatchType): number {
    return this.pool(type).length;
  }

  /** User ids currently waiting for a match type (to push live count updates). */
  userIdsIn(type: MatchType): string[] {
    return this.pool(type).map((e) => e.userId);
  }

  /**
   * If a startable group exists for `type`, REMOVE it from the pool and return it.
   * The longest-waiting player anchors the group; the bracket is centred on the
   * anchor's rating, and the anchor is paired with the closest-rated waiters.
   */
  formGroup(type: MatchType): QueueEntry[] | null {
    const needed = PLAYERS_PER_TYPE[type];
    const p = this.pool(type);
    if (p.length < needed) return null;

    const anchor = p.reduce((a, b) => (a.since <= b.since ? a : b)); // oldest waiter
    const eligible = p.filter((e) => Math.abs(e.rating - anchor.rating) <= this.tolerance);
    if (eligible.length < needed) return null;

    const group = eligible
      .slice()
      .sort((a, b) => Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating) || a.since - b.since)
      .slice(0, needed);

    const chosen = new Set(group.map((e) => e.userId));
    this.queues.set(type, p.filter((e) => !chosen.has(e.userId)));
    return group;
  }
}
