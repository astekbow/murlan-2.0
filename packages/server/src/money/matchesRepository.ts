// Money-side record of a match: who staked, the pot, the rake rate, and the
// outcome. Mirrors the `matches` + `match_players` tables (spec §11). Lets
// settlement be idempotent (a match settles/cancels exactly once).

import type { MatchType } from '@murlan/shared';

export type MatchStatus = 'active' | 'settled' | 'cancelled';

export interface MatchPlayer {
  seat: number;
  userId: string;
}

export interface MatchRecord {
  id: string;
  type: MatchType;
  stakeCents: number;
  rakeBps: number;
  potCents: number;
  status: MatchStatus;
  winnerSeats: number[] | null;
  players: MatchPlayer[];
  createdAt: number;
  endedAt: number | null;
}

export interface NewMatch {
  id: string;
  type: MatchType;
  stakeCents: number;
  rakeBps: number;
  potCents: number;
  players: MatchPlayer[];
}

export interface MatchesRepository {
  create(m: NewMatch): Promise<MatchRecord>;
  find(id: string): Promise<MatchRecord | null>;
  markSettled(id: string, winnerSeats: number[]): Promise<void>;
  markCancelled(id: string): Promise<void>;
  /** Matches still 'active' — used by the crash-recovery sweeper to refund pots
   *  whose live room no longer exists (e.g. after a server crash mid-match). */
  listActive(): Promise<MatchRecord[]>;
}

export class InMemoryMatchesRepository implements MatchesRepository {
  private byId = new Map<string, MatchRecord>();

  async create(m: NewMatch): Promise<MatchRecord> {
    const record: MatchRecord = {
      ...m,
      players: m.players.map((p) => ({ ...p })),
      status: 'active',
      winnerSeats: null,
      createdAt: Date.now(),
      endedAt: null,
    };
    this.byId.set(record.id, record);
    return { ...record };
  }

  async find(id: string): Promise<MatchRecord | null> {
    const r = this.byId.get(id);
    return r ? { ...r, players: r.players.map((p) => ({ ...p })) } : null;
  }

  async markSettled(id: string, winnerSeats: number[]): Promise<void> {
    const r = this.byId.get(id);
    if (r) {
      r.status = 'settled';
      r.winnerSeats = [...winnerSeats];
      r.endedAt = Date.now();
    }
  }

  async markCancelled(id: string): Promise<void> {
    const r = this.byId.get(id);
    if (r) {
      r.status = 'cancelled';
      r.endedAt = Date.now();
    }
  }

  async listActive(): Promise<MatchRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.status === 'active')
      .map((r) => ({ ...r, players: r.players.map((p) => ({ ...p })) }));
  }
}
