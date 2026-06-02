// Durable provably-fair audit trail. Each dealt game persists its
// (serverSeed, serverSeedHash, clientSeed, nonce) IMMEDIATELY with revealed=false
// — so a crash or a player who disconnects before the post-match reveal can never
// lose the audit data. The serverSeed is stored server-side but only EXPOSED via
// the public verify endpoint once the match ends (revealed=true). Any player or
// regulator can then recompute every deal and check it against the commitment.

export interface GameRecord {
  matchId: string;
  index: number;
  serverSeed: string;     // stored from the start; only published when revealed
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  revealed: boolean;
  createdAt: number;
}

export interface NewGameRecord {
  matchId: string;
  index: number;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface GamesRepository {
  /** Persist one dealt game (idempotent on matchId+index). */
  recordGame(g: NewGameRecord): Promise<void>;
  /** Flip every game of a match to revealed (publish the serverSeed). */
  revealMatch(matchId: string): Promise<void>;
  /** All games of a match (ascending index). */
  listByMatch(matchId: string): Promise<GameRecord[]>;
}

export class InMemoryGames implements GamesRepository {
  private byKey = new Map<string, GameRecord>();
  private key(matchId: string, index: number): string {
    return `${matchId}#${index}`;
  }

  async recordGame(g: NewGameRecord): Promise<void> {
    const k = this.key(g.matchId, g.index);
    if (this.byKey.has(k)) return; // idempotent
    this.byKey.set(k, { ...g, revealed: false, createdAt: Date.now() });
  }
  async revealMatch(matchId: string): Promise<void> {
    for (const r of this.byKey.values()) if (r.matchId === matchId) r.revealed = true;
  }
  async listByMatch(matchId: string): Promise<GameRecord[]> {
    return [...this.byKey.values()].filter((r) => r.matchId === matchId).sort((a, b) => a.index - b.index).map((r) => ({ ...r }));
  }
}
