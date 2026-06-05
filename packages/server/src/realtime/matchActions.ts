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

export type MatchActionType = 'play' | 'pass' | 'switch';

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
}
