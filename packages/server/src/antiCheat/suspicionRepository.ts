// Storage for anti-collusion / anti-bot heuristic flags (manual review only).
// Interface + in-memory impl (Prisma impl mirrors it). Never drives auto-action.

export interface SuspicionFlag {
  id: string;
  userId: string;
  type: string;     // 'bot_timing' | 'win_rate'
  severity: number; // 1 low · 2 medium · 3 high
  detail: string;
  matchId: string | null;
  reviewed: boolean;
  createdAt: number;
}

export interface NewSuspicionFlag {
  userId: string;
  type: string;
  severity: number;
  detail: string;
  matchId?: string | null;
}

export interface SuspicionRepository {
  add(f: NewSuspicionFlag): Promise<void>;
  /** Newest-first flags, optionally filtered by minimum severity. */
  list(opts?: { minSeverity?: number; limit?: number }): Promise<SuspicionFlag[]>;
}

export class InMemorySuspicion implements SuspicionRepository {
  private flags: SuspicionFlag[] = [];
  private seq = 0;

  async add(f: NewSuspicionFlag): Promise<void> {
    this.seq += 1;
    this.flags.push({ id: `flag_${this.seq}`, userId: f.userId, type: f.type, severity: f.severity, detail: f.detail, matchId: f.matchId ?? null, reviewed: false, createdAt: Date.now() });
  }

  async list(opts: { minSeverity?: number; limit?: number } = {}): Promise<SuspicionFlag[]> {
    const min = opts.minSeverity ?? 1;
    return this.flags
      .filter((f) => f.severity >= min)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(0, opts.limit ?? 200))
      .map((f) => ({ ...f }));
  }
}
