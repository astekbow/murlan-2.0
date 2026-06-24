// ============================================================================
// MURLAN — Ranked service (seasons, MMR, tiers, leaderboard)
// ----------------------------------------------------------------------------
// Orchestrates the season ladder on top of SeasonRepository + the pure rating
// math in ranking.ts. MMR is competitive/cosmetic ONLY — never cashable, never
// touches the ledger or scoring. recordMatchResult is called isolated and
// fire-and-forget at match-end (like cosmetic XP) so a rating-write failure can
// NEVER affect money settlement or the rules engine.
// ============================================================================

import type {
  RankedProfileDTO, RankedLeaderboardRow, SeasonDTO, TierInfo, RankedTierKey,
} from '@murlan/shared';
import type { UserRepository } from '../auth/userRepository.ts';
import type { Season, SeasonRepository, UserSeason } from './seasonRepository.ts';
import {
  DEFAULT_RATING, TIERS, tierFromRating, applyMatchRatings, calculateNewRating, expectedScore, softReset, type Tier,
} from './ranking.ts';

export interface RankedSeat {
  userId: string;
  won: boolean;
}

export interface RatingDelta {
  userId: string;
  oldRating: number;
  newRating: number;
  tierKey: RankedTierKey;
  won: boolean;
  expectedWinRate: number; // 0..1 — Elo expected score vs the mean of the others
}

function toSeasonDTO(s: Season): SeasonDTO {
  return { id: s.id, number: s.number, name: s.name, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt };
}

/** Map the internal Tier to the client DTO, attaching the tier directly above. */
export function tierInfo(t: Tier): TierInfo {
  const idx = TIERS.findIndex((x) => x.key === t.key);
  const above = idx >= 0 && idx < TIERS.length - 1 ? TIERS[idx + 1]! : null;
  return {
    key: t.key,
    name: t.name,
    min: t.min,
    color: t.color,
    emoji: t.emoji,
    next: above ? { key: above.key, name: above.name, min: above.min } : null,
  };
}

export class RankedService {
  constructor(
    private readonly seasons: SeasonRepository,
    private readonly users: UserRepository,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** All tiers, for the client to render the ladder / reward preview. */
  tiers(): TierInfo[] {
    return TIERS.map((t) => tierInfo(t));
  }

  async getActiveSeason(): Promise<SeasonDTO | null> {
    const s = await this.seasons.getActiveSeason();
    return s ? toSeasonDTO(s) : null;
  }

  async listSeasons(): Promise<SeasonDTO[]> {
    return (await this.seasons.listSeasons()).map(toSeasonDTO);
  }

  /**
   * Open a new season (admin). Archives the current active season and, if one
   * existed, carries each player's peak forward via a soft reset so the new
   * ladder is competitive without erasing earned progress.
   */
  async createSeason(name: string, decayFactor = 0.5): Promise<SeasonDTO> {
    const now = this.now();
    const prev = await this.seasons.getActiveSeason();
    if (prev) await this.seasons.archiveSeason(prev.id, now);
    const number = prev ? prev.number + 1 : 1;
    const season = await this.seasons.createSeason({ number, name, decayFactor, startedAt: now });

    if (prev) {
      const carry = await this.seasons.listUserSeasons(prev.id);
      await Promise.all(
        carry.map((row) => {
          const seeded = softReset(row.peakRating, prev.decayFactor);
          return this.seasons.upsertUserSeason({
            userId: row.userId,
            seasonId: season.id,
            rating: seeded,
            peakRating: seeded,
            games: 0,
            wins: 0,
            updatedAt: now,
          });
        }),
      );
    }
    return toSeasonDTO(season);
  }

  private async ensureUserSeason(userId: string, seasonId: string): Promise<UserSeason> {
    const existing = await this.seasons.getUserSeason(userId, seasonId);
    if (existing) return existing;
    const fresh: UserSeason = {
      userId, seasonId, rating: DEFAULT_RATING, peakRating: DEFAULT_RATING, games: 0, wins: 0, updatedAt: this.now(),
    };
    await this.seasons.upsertUserSeason(fresh);
    return fresh;
  }

  /**
   * Apply a finished match to the active-season ladder. No active season ⇒ a
   * no-op (ranked is off). A voided/refunded match (no winner) is NOT rated.
   * Returns per-player deltas for optional surfacing (never required for play).
   */
  async recordMatchResult(seats: RankedSeat[]): Promise<RatingDelta[]> {
    if (seats.length < 2) return [];
    if (!seats.some((s) => s.won)) return []; // voided/refunded match — not rated
    const season = await this.seasons.getActiveSeason();
    if (!season) return [];

    const rows = await Promise.all(seats.map((s) => this.ensureUserSeason(s.userId, season.id)));
    const newRatings = applyMatchRatings(rows.map((r, i) => ({ rating: r.rating, won: seats[i]!.won })));
    // Each player's expected win prob = Elo expected score vs the MEAN rating of
    // everyone else — the exact opponentAvg the rating math uses, so the surfaced
    // "% expected" lines up with the awarded delta.
    const total = rows.reduce((sum, r) => sum + r.rating, 0);

    const now = this.now();
    const deltas: RatingDelta[] = [];
    await Promise.all(
      rows.map((row, i) => {
        const newRating = newRatings[i]!;
        const won = seats[i]!.won;
        const opponentAvg = rows.length > 1 ? (total - row.rating) / (rows.length - 1) : row.rating;
        deltas.push({
          userId: row.userId,
          oldRating: row.rating,
          newRating,
          tierKey: tierFromRating(newRating).key,
          won,
          expectedWinRate: expectedScore(row.rating, opponentAvg),
        });
        return this.seasons.upsertUserSeason({
          userId: row.userId,
          seasonId: season.id,
          rating: newRating,
          peakRating: Math.max(row.peakRating, newRating),
          games: row.games + 1,
          wins: row.wins + (won ? 1 : 0),
          updatedAt: now,
        });
      }),
    );
    return deltas;
  }

  /**
   * Rate a LONE human who was matched against BOT(s) (the ranked solo-queue → vs-bot
   * fallback). A bot is not a real player and never carries a ranked record, so the
   * normal ≥2-player path doesn't apply. We rate the human against a SYNTHETIC opponent
   * of EQUAL rating: expected score is exactly 0.5, so the swing is the standard K-factor
   * (±K/2) — a win nudges them up the ladder, a loss down, identical to facing an
   * evenly-matched human. Only the human's rating + season standing is written (the bot
   * gets nothing). No active season ⇒ a clean no-op (ranked is off), like recordMatchResult.
   */
  async recordSoloVsBot(userId: string, won: boolean): Promise<RatingDelta[]> {
    const season = await this.seasons.getActiveSeason();
    if (!season) return [];
    const row = await this.ensureUserSeason(userId, season.id);
    // Equal-rated synthetic opponent ⇒ expectedScore = 0.5 ⇒ full ±K/2 swing.
    const newRating = calculateNewRating(row.rating, row.rating, won);
    const now = this.now();
    await this.seasons.upsertUserSeason({
      userId,
      seasonId: season.id,
      rating: newRating,
      peakRating: Math.max(row.peakRating, newRating),
      games: row.games + 1,
      wins: row.wins + (won ? 1 : 0),
      updatedAt: now,
    });
    return [{
      userId,
      oldRating: row.rating,
      newRating,
      tierKey: tierFromRating(newRating).key,
      won,
      expectedWinRate: 0.5, // by construction — even-rated synthetic opponent
    }];
  }

  /** A viewer's own ranked standing in the active season. */
  async getUserRanked(userId: string): Promise<RankedProfileDTO> {
    const season = await this.seasons.getActiveSeason();
    if (!season) {
      return {
        season: null, rating: DEFAULT_RATING, peakRating: DEFAULT_RATING,
        tier: tierInfo(tierFromRating(DEFAULT_RATING)), games: 0, wins: 0, winRate: 0,
      };
    }
    const row = (await this.seasons.getUserSeason(userId, season.id)) ?? {
      userId, seasonId: season.id, rating: DEFAULT_RATING, peakRating: DEFAULT_RATING, games: 0, wins: 0, updatedAt: this.now(),
    };
    return {
      season: toSeasonDTO(season),
      rating: row.rating,
      peakRating: row.peakRating,
      tier: tierInfo(tierFromRating(row.rating)),
      games: row.games,
      wins: row.wins,
      winRate: row.games > 0 ? row.wins / row.games : 0,
    };
  }

  /** Top players in the active season by rating. Empty if ranked is off. */
  async leaderboard(limit = 50): Promise<RankedLeaderboardRow[]> {
    const season = await this.seasons.getActiveSeason();
    if (!season) return [];
    const top = await this.seasons.topByRating(season.id, limit);
    // Batch-fetch every leaderboard user in ONE query (was N+1: a findById per row).
    const users = await this.users.findManyByIds(top.map((r) => r.userId)).catch(() => []);
    const byId = new Map(users.map((u) => [u.id, u]));
    return top.map((r, i) => {
      const u = byId.get(r.userId);
      return {
        rank: i + 1,
        userId: r.userId,
        username: u?.username ?? '—',
        avatar: u?.avatar ?? null,
        rating: r.rating,
        peakRating: r.peakRating,
        tier: tierInfo(tierFromRating(r.rating)),
        games: r.games,
        wins: r.wins,
        winRate: r.games > 0 ? r.wins / r.games : 0,
      } satisfies RankedLeaderboardRow;
    });
  }
}
