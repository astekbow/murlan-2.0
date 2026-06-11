// ============================================================================
// MURLAN — Profile / progression service (Phase 5, §2.3 / §2.4)
// ----------------------------------------------------------------------------
// Cosmetic progression ONLY: XP, levels, and play stats. Never touches money,
// scoring, or the rules engine. The match-end hook is wrapped by callers so a
// failure here can never affect settlement.
// ============================================================================

import type { UserRepository, User } from '../auth/userRepository.ts';
import { levelInfo, XP_PLAY, XP_WIN, type LevelInfo } from './level.ts';

/** Cosmetic avatar ids (a fixed preset set; the client maps these to art). */
export const AVATARS = [
  'spade', 'heart', 'club', 'diamond', 'crown', 'star',
  'lion', 'dragon', 'knight', 'joker', 'cherry', 'skull',
] as const;
export type AvatarId = (typeof AVATARS)[number];

// An uploaded avatar is stored inline as a small data URL. The client resizes to a
// tiny thumbnail first; this cap (~9KB) keeps profiles/leaderboards from bloating.
const MAX_AVATAR_DATA_URL = 12_000;
function isValidAvatar(avatar: string): boolean {
  if ((AVATARS as readonly string[]).includes(avatar)) return true;
  return avatar.length <= MAX_AVATAR_DATA_URL && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar);
}

export interface PublicProfile {
  id: string;
  username: string;
  avatar: string | null;
  xp: number;
  level: number;
  levelInfo: LevelInfo;
  gamesPlayed: number;
  wins: number;
  winRate: number; // 0..1
  biggestPotCents: number;
  currentStreak: number;
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  username: string;
  avatar: string | null;
  level: number;
  xp: number;
  wins: number;
  gamesPlayed: number;
  winRate: number;
}

function toPublic(u: User): PublicProfile {
  const li = levelInfo(u.xp);
  return {
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    xp: u.xp,
    level: li.level,
    levelInfo: li,
    gamesPlayed: u.gamesPlayed,
    wins: u.wins,
    winRate: u.gamesPlayed > 0 ? u.wins / u.gamesPlayed : 0,
    biggestPotCents: u.biggestPotCents,
    currentStreak: u.currentStreak,
  };
}

export class ProfileService {
  constructor(private readonly users: UserRepository) {}

  async getProfile(userId: string): Promise<PublicProfile | null> {
    const u = await this.users.findById(userId);
    return u ? toPublic(u) : null;
  }

  /** Cosmetic avatar change. Accepts a preset id OR a small uploaded image stored
   *  as a data URL (the client resizes to a tiny thumbnail before sending). */
  async setAvatar(userId: string, avatar: string): Promise<PublicProfile | null> {
    if (!isValidAvatar(avatar)) throw new Error('invalid avatar');
    const u = await this.users.setAvatar(userId, avatar);
    return u ? toPublic(u) : null;
  }

  /**
   * Award XP + update stats for a finished match. `seats` lists each seated
   * player with whether they won and the pot they were part of. Cosmetic only:
   * each update is isolated so one failure can't abort the others (or money).
   */
  async recordMatch(seats: Array<{ userId: string; won: boolean; potCents: number }>): Promise<void> {
    await Promise.all(
      seats.map((s) =>
        this.users
          .applyMatchResult(s.userId, { won: s.won, potCents: s.potCents, xpGain: XP_PLAY + (s.won ? XP_WIN : 0) })
          .catch(() => null),
      ),
    );
  }

  async leaderboard(limit = 50): Promise<LeaderboardRow[]> {
    const top = await this.users.topByXp(limit);
    return top.map((u, i) => ({
      rank: i + 1,
      id: u.id,
      username: u.username,
      avatar: u.avatar,
      level: levelInfo(u.xp).level,
      xp: u.xp,
      wins: u.wins,
      gamesPlayed: u.gamesPlayed,
      winRate: u.gamesPlayed > 0 ? u.wins / u.gamesPlayed : 0,
    }));
  }
}
