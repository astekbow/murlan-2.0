// ============================================================================
// MURLAN — Profile / progression service (Phase 5, §2.3 / §2.4)
// ----------------------------------------------------------------------------
// Cosmetic progression ONLY: XP, levels, and play stats. Never touches money,
// scoring, or the rules engine. The match-end hook is wrapped by callers so a
// failure here can never affect settlement.
// ============================================================================

import type { UserRepository, User } from '../auth/userRepository.ts';
import { levelInfo, XP_PLAY, XP_WIN, type LevelInfo } from './level.ts';
import { newlyEarnedAchievements } from '../rewards/achievements.ts';
import { vipTierFor, stakedVolume, vipXpMultiplier } from '../vip/vipService.ts';
import type { VipTierInfo } from '@murlan/shared';
import type { Transaction } from '../money/ledger.ts';

/** Read-only ledger access — used ONLY to derive the cosmetic VIP tier badge.
 *  Optional so callers/tests without a wallet still work (no badge then). */
interface LedgerReader {
  listTransactions: (userId: string) => Promise<Transaction[]>;
  // Bounded DB aggregate of lifetime staked volume (audit M4) — used on the hot paths (every
  // match-end + every profile open) instead of scanning the whole ledger; absent → fall back.
  stakedVolumeCents?: (userId: string) => Promise<number>;
}

/** Cosmetic avatar ids (a fixed preset set; the client maps these to art). */
export const AVATARS = [
  'spade', 'heart', 'club', 'diamond', 'crown', 'star',
  'lion', 'dragon', 'knight', 'joker', 'cherry', 'skull',
] as const;
export type AvatarId = (typeof AVATARS)[number];

// An uploaded avatar is stored inline as a small data URL. The client resizes to a
// tiny thumbnail first; this cap (~18KB) keeps profiles/leaderboards from bloating while
// giving a 64×64 photo enough headroom (some detailed shots exceeded the old 12KB cap).
const MAX_AVATAR_DATA_URL = 24_000;
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
  /** Cosmetic VIP tier (bronze+) for the avatar ring; null for standard/no-ledger. */
  vipTier: VipTierInfo | null;
  /** Earned achievement/season BADGE ids (cosmetic). The client maps ids → icon/label. */
  badges: string[];
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

function toPublic(u: User, vipTier: VipTierInfo | null = null): PublicProfile {
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
    vipTier,
    badges: u.badges,
  };
}

// ----------------------------------------------------------------------------
// Demo leaderboard roster (§ klasifikimi). When `demoLeaderboard` is on, ~100
// DETERMINISTIC demo players are merged into the global XP board so a fresh launch
// looks populated. Deterministic = derived from a fixed seeded list (no per-call
// randomness), so the board is stable across refreshes. Each demo row carries an
// `id` of `demo_<n>` so the client can detect them and render them non-interactive
// (a profile fetch would 404). The XP spread mostly EXCEEDS a fresh account (≈200..
// 80000) so a brand-new real player lands MID/LOW pack, never #1.
// ----------------------------------------------------------------------------

// Albanian first names + a handful of surnames, cycled to build the roster.
const DEMO_FIRST_NAMES = [
  'Andi', 'Besa', 'Marsel', 'Ana', 'Erjon', 'Klara', 'Gent', 'Drita', 'Florian', 'Ina',
  'Arben', 'Elira', 'Bujar', 'Vesa', 'Dritan', 'Lira', 'Gezim', 'Majlinda', 'Sokol', 'Teuta',
  'Endrit', 'Blerta', 'Kreshnik', 'Fjolla', 'Ilir', 'Suela', 'Agron', 'Mira', 'Petrit', 'Donika',
  'Genc', 'Albana', 'Lulzim', 'Rudina', 'Shpend', 'Valbona', 'Astrit', 'Edona', 'Bardhyl', 'Jonida',
] as const;
const DEMO_SURNAMES = ['Hoxha', 'Krasniqi', 'Berisha', 'Gashi', 'Shala', 'Dauti', 'Leka', 'Prifti'] as const;

export interface DemoPlayer { id: string; username: string; avatar: string; xp: number; wins: number; gamesPlayed: number }

const DEMO_COUNT = 100;

/** A small deterministic PRNG (mulberry32) so the roster is identical every boot/refresh. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the fixed ~100-player demo roster once (module-level, so it's stable + cheap). */
function buildDemoRoster(): DemoPlayer[] {
  const rnd = mulberry32(0x4d55524c); // 'MURL' — a fixed seed → deterministic across runs
  const out: DemoPlayer[] = [];
  for (let i = 0; i < DEMO_COUNT; i++) {
    const first = DEMO_FIRST_NAMES[i % DEMO_FIRST_NAMES.length]!;
    // Every 5th player gets a surname; others get a number suffix to keep names unique.
    const username = i % 5 === 0
      ? `${first} ${DEMO_SURNAMES[(i * 3) % DEMO_SURNAMES.length]!}`
      : `${first}${Math.floor(i / DEMO_FIRST_NAMES.length) > 0 ? i : ''}` || first;
    // XP spread ≈200..80000, biased so MOST demo players sit comfortably above a fresh
    // account: rank 0 (i=0) ~ highest. Use an exponential-ish curve over the index.
    const frac = 1 - i / DEMO_COUNT; // 1.0 (top) .. ~0.0 (bottom)
    const xp = Math.round(200 + Math.pow(frac, 1.8) * 79_800); // ~200..80000
    const gamesPlayed = 20 + Math.floor(rnd() * 480); // 20..500 games
    const winRate = 0.3 + rnd() * 0.35;               // 0.30..0.65
    const wins = Math.round(gamesPlayed * winRate);
    const avatar = AVATARS[Math.floor(rnd() * AVATARS.length)]!;
    out.push({ id: `demo_${i}`, username, avatar, xp, wins, gamesPlayed });
  }
  return out;
}

const DEMO_ROSTER: DemoPlayer[] = buildDemoRoster();

export class ProfileService {
  /** `demoLeaderboard`: when true, merge the deterministic demo roster into leaderboard(). */
  constructor(
    private readonly users: UserRepository,
    private readonly ledger?: LedgerReader,
    private readonly demoLeaderboard = false,
  ) {}

  async getProfile(userId: string): Promise<PublicProfile | null> {
    let u = await this.users.findById(userId);
    if (!u) return null;
    // Lazily GRANT any achievement this user has now earned (idempotent — only ids not
    // already held are appended), so badges appear on the profile even if they never open
    // the Rewards view. Cosmetic + best-effort: a write hiccup must never block the read.
    const newly = newlyEarnedAchievements(u);
    if (newly.length > 0) {
      const updated = await this.users.setRewards(userId, { badges: [...u.badges, ...newly] }).catch(() => null);
      if (updated) u = updated;
    }
    // Derive the cosmetic VIP tier from lifetime staked volume (same source as VipService).
    // Read-only + best-effort: a ledger hiccup must never block viewing a profile.
    let vipTier: VipTierInfo | null = null;
    if (this.ledger) {
      try {
        const staked = this.ledger.stakedVolumeCents
          ? await this.ledger.stakedVolumeCents(userId)
          : stakedVolume(await this.ledger.listTransactions(userId));
        const tier = vipTierFor(staked);
        if (tier.key !== 'standard') vipTier = tier;
      } catch { /* cosmetic only */ }
    }
    return toPublic(u, vipTier);
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
      seats.map(async (s) => {
        const base = XP_PLAY + (s.won ? XP_WIN : 0);
        // VIP perk: boost match XP by the player's tier multiplier (derived from lifetime staked
        // volume, same source as the VIP badge). Best-effort — a ledger hiccup just means no boost.
        let mult = 1;
        if (this.ledger) {
          try {
            const staked = this.ledger.stakedVolumeCents
              ? await this.ledger.stakedVolumeCents(s.userId)
              : stakedVolume(await this.ledger.listTransactions(s.userId));
            mult = vipXpMultiplier(vipTierFor(staked));
          } catch { /* no boost on failure */ }
        }
        const xpGain = Math.round(base * mult);
        return this.users
          .applyMatchResult(s.userId, { won: s.won, potCents: s.potCents, xpGain })
          .catch(() => null);
      }),
    );
  }

  async leaderboard(limit = 50): Promise<LeaderboardRow[]> {
    // Always include the REAL top users. Fetch up to `limit` of them so a signed-in
    // owner can still land at their natural rank among the merged set.
    const real = await this.users.topByXp(limit);
    type Row = Omit<LeaderboardRow, 'rank'>;
    const rows: Row[] = real.map((u) => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar,
      level: levelInfo(u.xp).level,
      xp: u.xp,
      wins: u.wins,
      gamesPlayed: u.gamesPlayed,
      winRate: u.gamesPlayed > 0 ? u.wins / u.gamesPlayed : 0,
    }));

    if (this.demoLeaderboard) {
      // Merge the deterministic demo roster. Demo `xp` mostly EXCEEDS a fresh account, so a
      // brand-new real player sorts into the MID/LOW pack — never #1.
      for (const d of DEMO_ROSTER) {
        rows.push({
          id: d.id,
          username: d.username,
          avatar: d.avatar,
          level: levelInfo(d.xp).level,
          xp: d.xp,
          wins: d.wins,
          gamesPlayed: d.gamesPlayed,
          winRate: d.gamesPlayed > 0 ? d.wins / d.gamesPlayed : 0,
        });
      }
    }

    // Sort by XP desc (tie-break wins desc, then id for a STABLE order across refreshes),
    // assign ranks, return the top `limit`.
    rows.sort((a, b) => b.xp - a.xp || b.wins - a.wins || a.id.localeCompare(b.id));
    return rows.slice(0, Math.max(0, limit)).map((r, i) => ({ rank: i + 1, ...r }));
  }

  /** Username search for friend discovery — minimal public shape, bounded, caller excluded. */
  async searchUsers(q: string, limit: number, excludeUserId?: string): Promise<Array<{ id: string; username: string; avatar: string | null; level: number }>> {
    return this.users.searchByUsername(q, limit, excludeUserId);
  }
}
