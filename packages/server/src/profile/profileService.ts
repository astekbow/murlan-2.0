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
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/;

/** True if the decoded bytes start with the file signature (MAGIC BYTES) of a real
 *  PNG/JPEG/WEBP/GIF image (authz-2). The MIME prefix is attacker-controlled, so we must
 *  confirm the actual content — a `data:image/png` URL carrying a script/SVG payload
 *  (latent stored-XSS) fails here because its bytes don't match a real image signature. */
function hasImageMagic(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return true;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // GIF: "GIF87a" / "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return true;
  // WEBP: "RIFF"...."WEBP" (bytes 0–3 = RIFF, 8–11 = WEBP)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  return false;
}

function isValidAvatar(avatar: string): boolean {
  if ((AVATARS as readonly string[]).includes(avatar)) return true;
  if (avatar.length > MAX_AVATAR_DATA_URL) return false;
  const m = AVATAR_DATA_URL_RE.exec(avatar);
  if (!m) return false;
  // Decode the base64 payload and confirm its real magic bytes match an image format —
  // the declared MIME (m[1]) alone is not trusted (authz-2).
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2]!, 'base64');
  } catch {
    return false;
  }
  return hasImageMagic(bytes);
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
