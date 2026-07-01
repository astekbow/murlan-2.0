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
/** Bot "thinking" delay before it acts, for a natural pace (ms). Kept for tests / fallback. */
export const BOT_MIN_DELAY = 550;
export const BOT_MAX_DELAY = 1100;
/**
 * Human-like "thinking" pause before a bot acts (ms). A flat 0.55–1.1s band felt robotic
 * (every move the same metronomic tempo). Instead: a reaction floor + time that grows with how
 * much there is to weigh (hand size), a touch more when LEADING (an open choice) than when just
 * beating the pile, natural jitter, and an occasional longer ponder so the rhythm isn't uniform.
 * Range ≈ 0.8–2.6s — clearly under the turn timeout, so timers/tests are unaffected.
 */
export function botThinkDelay(handSize: number, leading: boolean): number {
  const base = 700;                                  // reaction floor (no more near-instant 550)
  const perCard = Math.min(handSize, 14) * 45;       // more cards → more to consider (13 → ~585ms)
  const leadBonus = leading ? 250 : 0;               // leading = a freer decision → deliberate a bit
  const jitter = Math.floor(Math.random() * 500);    // 0–500ms natural variance
  // ~12% of moves: a longer "thinking hard" pause so the pace never feels mechanical.
  const ponder = Math.random() < 0.12 ? Math.floor(Math.random() * 900) : 0;
  return Math.min(2600, base + perCard + leadBonus + jitter + ponder);
}
