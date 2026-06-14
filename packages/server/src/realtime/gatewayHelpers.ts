// Pure, dependency-free leaf helpers + constants for the gateway. Kept in a small
// module (rather than inline in the 1.5k-LOC gateway) so they're independently
// readable/testable and the gateway file shrinks. A first, safe step of the larger
// gateway decomposition — these have ZERO coupling to gateway instance state.

// ---- Channel names (Socket.IO rooms) --------------------------------------
/** Per-user private channel (private hands, turn prompts, invites). */
export function personalRoom(userId: string): string {
  return `u:${userId}`;
}
/** Per-club broadcast channel (club chat). */
export function clubRoom(clubId: string): string {
  return `club:${clubId}`;
}

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
/** Bot "thinking" delay before it acts, for a natural pace (ms). */
export const BOT_MIN_DELAY = 550;
export const BOT_MAX_DELAY = 1100;
