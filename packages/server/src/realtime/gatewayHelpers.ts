// Pure, dependency-free leaf helpers + constants for the gateway. Kept in a small
// module (rather than inline in the 1.5k-LOC gateway) so they're independently
// readable/testable and the gateway file shrinks. A first, safe step of the larger
// gateway decomposition — these have ZERO coupling to gateway instance state.

import type { BotTier } from '../bot/botDecision.ts';

/** A random difficulty for ONE free-table fill bot, weighted toward the stronger brains so a
 *  casual host meets VARIED opponents (not an all-hard wall): easy 20% · medium 40% · hard 40%. */
export function pickFillTier(rng: () => number = Math.random): BotTier {
  const r = rng();
  return r < 0.2 ? 'easy' : r < 0.6 ? 'medium' : 'hard';
}

// ---- Channel names (Socket.IO rooms) --------------------------------------
/** Per-user private channel (private hands, turn prompts, invites). */
export function personalRoom(userId: string): string {
  return `u:${userId}`;
}
/** Per-club broadcast channel (club chat). */
export function clubRoom(clubId: string): string {
  return `club:${clubId}`;
}
/** Shared broadcast channel for every client currently viewing the leaderboard
 *  (joined while the page is open). A finished match pushes a refresh here so
 *  ranks move live without polling. */
export const LEADERBOARD_ROOM = 'leaderboard';

// ---- Fill players (a.k.a. practice bots) -----------------------------------
// Synthetic, socket-less "players" seated ONLY in zero-stake rooms (escrow is gated
// on stakeCents>0, so they NEVER touch money — this is the hard structural guard
// that keeps them out of every real-money game). Identified internally by a userId
// prefix; the client only ever receives their `username`, so a human-like name makes
// them indistinguishable on a free/practice table (no money is ever at stake).
export const BOT_PREFIX = 'bot:';
export const isBot = (userId: string | null): boolean => !!userId && userId.startsWith(BOT_PREFIX);
/** Human-like names so a free-table opponent doesn't read as a robot. */
export const GHOST_NAMES = [
  'Andi', 'Beni', 'Gent', 'Eri', 'Drini', 'Ardit', 'Sokol', 'Ilir', 'Endri', 'Redi',
  'Joni', 'Marsel', 'Kreshnik', 'Fatos', 'Besa', 'Era', 'Ana', 'Lira', 'Doni', 'Rina',
  'Eda', 'Klea', 'Noa', 'Toni', 'Geri', 'Leo', 'Dea', 'Iris',
];
/** Pick `count` DISTINCT random ghost names, avoiding `exclude` (the human's name). */
export function pickGhostNames(count: number, exclude?: string | null): string[] {
  const pool = GHOST_NAMES.filter((n) => n.toLowerCase() !== (exclude ?? '').trim().toLowerCase());
  for (let i = pool.length - 1; i > 0; i -= 1) { // Fisher–Yates shuffle
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.max(0, count));
}
/** Bot "thinking" pause bounds before it acts (ms). Owner spec (2026-07-03): a human-like pause
 *  of 3–5 seconds, NEVER under 3s. These are the hard floor + ceiling; botThinkDelay lands between. */
export const BOT_MIN_DELAY = 3000;
export const BOT_MAX_DELAY = 5000;
/**
 * Human-like "thinking" pause before a bot acts (ms). Owner spec: random 3–5s, NEVER faster than 3s
 * — so a bot never snaps a move out instantly and reads like a real opponent taking their time. The
 * 3s FLOOR is guaranteed; on top of it we lean toward the longer end when there's genuinely more to
 * weigh (a big hand, or LEADING a fresh trick = an open choice) and add natural jitter + an occasional
 * longer ponder, so the tempo never feels metronomic. Clamped to the 5s ceiling — still well under
 * the turn timeout, so timers are unaffected. `rng` is injectable for deterministic tests.
 */
export function botThinkDelay(handSize: number, leading: boolean, rng: () => number = Math.random): number {
  const deliberation = Math.round((Math.min(handSize, 14) / 14) * 700); // 0–700ms: more cards, more to weigh
  const leadBonus = leading ? 250 : 0;                                  // leading = a freer decision
  const jitter = Math.floor(rng() * 800);                              // 0–800ms natural variance
  const ponder = rng() < 0.15 ? Math.floor(rng() * 750) : 0;          // ~15%: a longer "thinking hard" pause
  // BOT_MIN_DELAY (3000) is the hard floor; the rest stacks on top and is capped at BOT_MAX_DELAY (5000).
  return Math.min(BOT_MAX_DELAY, BOT_MIN_DELAY + deliberation + leadBonus + jitter + ponder);
}
