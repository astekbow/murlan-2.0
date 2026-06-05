// ============================================================================
// MURLAN — Anti-collusion / anti-bot service
// ----------------------------------------------------------------------------
// Runs the pure heuristics over a finished match (the persisted move-log) + each
// player's cumulative stats, and records flags for MANUAL admin review. Never
// takes an automatic action. Called isolated/fire-and-forget at match-end, so a
// failure here can't affect settlement, scoring, or the rules engine.
// ============================================================================

import type { MatchActionsRepository } from '../realtime/matchActions.ts';
import type { UserRepository } from '../auth/userRepository.ts';
import type { SuspicionRepository, SuspicionFlag } from './suspicionRepository.ts';
import { moveTimingFlags, winRateFlag, collusionFlags, type PastMatch } from './heuristics.ts';

export interface SeatUser {
  seat: number;
  userId: string;
  won?: boolean;        // present for collusion analysis (derived from the winners)
  team?: number | null; // 2v2 team (null otherwise)
}

/** Recent staked matches kept in memory for the cross-match collusion window. */
const COLLUSION_WINDOW = 30;

export class AntiCheatService {
  constructor(
    private readonly matchLog: MatchActionsRepository,
    private readonly users: UserRepository,
    private readonly flags: SuspicionRepository,
  ) {}

  // Single-instance in-memory window of recent STAKED matches (collusion is about
  // money; free/practice tables are not analyzed). Best-effort: only matches since
  // server start are considered — a Postgres-backed historical query is a follow-up.
  private recentStaked: PastMatch[] = [];

  /** Analyze a finished match + its players; record any heuristic flags. */
  async analyzeMatch(matchId: string, seats: SeatUser[], opts: { staked?: boolean } = {}): Promise<void> {
    // Bot-timing from the move-log (map seat → userId).
    const actions = await this.matchLog.listByMatch(matchId);
    for (const t of moveTimingFlags(actions)) {
      const u = seats.find((s) => s.seat === t.seat);
      if (u) await this.flags.add({ userId: u.userId, type: t.type, severity: t.severity, detail: t.detail, matchId });
    }
    // Win-rate anomaly from cumulative stats.
    for (const s of seats) {
      const user = await this.users.findById(s.userId).catch(() => null);
      if (!user) continue;
      const wr = winRateFlag(user.gamesPlayed, user.wins);
      if (wr) await this.flags.add({ userId: s.userId, type: wr.type, severity: wr.severity, detail: wr.detail, matchId });
    }
    // Collusion (staked matches only, and only once we know the per-seat outcome).
    if (opts.staked && seats.every((s) => s.won !== undefined)) {
      await this.analyzeCollusion(matchId, seats);
    }
  }

  private async analyzeCollusion(matchId: string, seats: SeatUser[]): Promise<void> {
    this.recentStaked.push({ seats: seats.map((s) => ({ userId: s.userId, won: s.won === true, team: s.team ?? null })) });
    if (this.recentStaked.length > COLLUSION_WINDOW) this.recentStaked.shift();

    for (const f of collusionFlags(this.recentStaked)) {
      const partner = await this.users.findById(f.partnerId).catch(() => null);
      const name = partner?.username ?? f.partnerId;
      const detail = f.type === 'collusion_pairing'
        ? `u ndesh ${f.count} herë me ${name} në dritaren e fundit (dyshim bashkëpunimi)`
        : `humbi ${f.count} herë radhazi ndaj ${name} (dyshim chip-dump)`;
      await this.flags.add({ userId: f.userId, type: f.type, severity: f.severity, detail, matchId });
    }
  }

  listFlags(opts?: { minSeverity?: number; limit?: number }): Promise<SuspicionFlag[]> {
    return this.flags.list(opts);
  }
}
