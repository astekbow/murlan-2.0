// ============================================================================
// MURLAN — Match move-log (deterministic replay + dispute/audit trail)
// ----------------------------------------------------------------------------
// Persists every applied move (play / pass / switch-give) in turn order. Combined
// with the durable provably-fair seeds (which reproduce each deal), the log lets
// any finished match be replayed move-for-move and audited — the foundation for
// replays, spectator fairness, and dispute resolution.
//
// Recording is isolated and fire-and-forget on the gameplay hot path: it can NEVER
// block a play or affect scoring/money. `seq` is assigned by the caller
// (synchronously, monotonically per match) so ordering is correct regardless of
// async write timing. Like every repo, an in-memory impl mirrors the Prisma one.
// ============================================================================

import type { Card } from '@murlan/engine';

// 'forfeit' marks the turn-ordered point at which a seat's player abandoned the
// match (left / disconnected past grace / idled out). It carries no cards and lets
// a replay/audit show an explicit "left" marker instead of the seat silently
// ceasing to act. The match continues without them (see Match.forfeit).
export type MatchActionType = 'play' | 'pass' | 'switch' | 'forfeit';

export interface MatchActionRecord {
  matchId: string;
  seq: number;        // monotonic within the match (turn order)
  gameIndex: number;  // which game within the match the action belonged to
  seat: number;
  type: MatchActionType;
  cards: Card[] | null; // played cards / the given card; null for a pass
  at: number;         // epoch ms
}

export interface NewMatchAction {
  matchId: string;
  seq: number;
  gameIndex: number;
  seat: number;
  type: MatchActionType;
  cards: Card[] | null;
  at: number;
}

export interface MatchActionsRepository {
  /** Append one applied move. Idempotent on (matchId, seq). */
  append(a: NewMatchAction): Promise<void>;
  /** Every action of a match, ascending by seq. */
  listByMatch(matchId: string): Promise<MatchActionRecord[]>;
  /** Data retention: delete moves recorded before `cutoffMs`. Returns rows removed. */
  deleteOlderThan(cutoffMs: number): Promise<number>;
}

const cloneCards = (cards: Card[] | null): Card[] | null => (cards ? cards.map((c) => ({ ...c })) : null);

/** In-memory implementation for tests and single-instance local dev. */
export class InMemoryMatchActions implements MatchActionsRepository {
  private byMatch = new Map<string, MatchActionRecord[]>();

  async append(a: NewMatchAction): Promise<void> {
    const arr = this.byMatch.get(a.matchId) ?? [];
    if (arr.some((r) => r.seq === a.seq)) return; // idempotent on (matchId, seq)
    arr.push({ ...a, cards: cloneCards(a.cards) });
    this.byMatch.set(a.matchId, arr);
  }

  async listByMatch(matchId: string): Promise<MatchActionRecord[]> {
    return (this.byMatch.get(matchId) ?? [])
      .slice()
      .sort((x, y) => x.seq - y.seq)
      .map((r) => ({ ...r, cards: cloneCards(r.cards) }));
  }

  async deleteOlderThan(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (const [matchId, rows] of this.byMatch) {
      const kept = rows.filter((r) => r.at >= cutoffMs);
      removed += rows.length - kept.length;
      if (kept.length === 0) this.byMatch.delete(matchId);
      else this.byMatch.set(matchId, kept);
    }
    return removed;
  }
}
