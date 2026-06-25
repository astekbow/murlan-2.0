// ============================================================================
// MURLAN — Club War (round-robin series between two clubs). Storage interface +
// in-memory impl; the Prisma impl mirrors it. A war escrows per-player buy-ins
// (free = 0), pairs every A-roster member vs every B-roster member, tallies club
// wins, and on finish splits the pool (minus rake) among the WINNING club's roster
// — or refunds everyone on a tie/cancel. Money math lives in clubWarService (pure).
// ============================================================================

export type ClubWarStatus = 'registering' | 'running' | 'finished' | 'cancelled';

export interface WarPairing {
  aUserId: string;
  bUserId: string;
  winnerId: string | null; // null = not yet played
}

export interface ClubWar {
  id: string;
  clubAId: string;        // the founder's club (challenger)
  clubBId: string;        // the opponent club
  status: ClubWarStatus;
  stakeCents: number;     // per-player buy-in; 0 = free
  rakeBps: number;        // house cut on the pool at payout
  size: number;           // target roster size per club (war auto-starts when BOTH reach it)
  rosterA: string[];      // registered (+ escrowed) club-A players
  rosterB: string[];
  pairings: WarPairing[]; // round-robin A×B, generated at start
  scoreA: number;         // pairing wins by club A
  scoreB: number;
  prizePoolCents: number; // sum of escrowed buy-ins
  winnerClubId: string | null; // set at finish; null on a tie (refunded) / cancel
  createdAt: number;
}

export interface ClubWarRepository {
  create(w: ClubWar): Promise<ClubWar>;
  get(id: string): Promise<ClubWar | null>;
  save(w: ClubWar): Promise<void>;
  /** Active + recent wars involving a club (either side), newest first. */
  listForClub(clubId: string, limit: number): Promise<ClubWar[]>;
  /** Wars still in a non-terminal state (registering/running) — for the stranded-money sweep. */
  listActive(): Promise<ClubWar[]>;
}

export class InMemoryClubWars implements ClubWarRepository {
  private wars = new Map<string, ClubWar>();

  async create(w: ClubWar): Promise<ClubWar> {
    this.wars.set(w.id, structuredClone(w));
    return structuredClone(w);
  }
  async get(id: string): Promise<ClubWar | null> {
    const w = this.wars.get(id);
    return w ? structuredClone(w) : null;
  }
  async save(w: ClubWar): Promise<void> {
    this.wars.set(w.id, structuredClone(w));
  }
  async listForClub(clubId: string, limit: number): Promise<ClubWar[]> {
    return [...this.wars.values()]
      .filter((w) => w.clubAId === clubId || w.clubBId === clubId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(0, limit))
      .map((w) => structuredClone(w));
  }
  async listActive(): Promise<ClubWar[]> {
    return [...this.wars.values()]
      .filter((w) => w.status === 'registering' || w.status === 'running')
      .map((w) => structuredClone(w));
  }
}
