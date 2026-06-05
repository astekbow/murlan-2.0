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

// ---- Practice bots ---------------------------------------------------------
// Bots are synthetic, socket-less "players" seated in zero-stake rooms (escrow is
// gated on stakeCents>0, so they never touch money), identified by a userId prefix.
export const BOT_PREFIX = 'bot:';
export const isBot = (userId: string | null): boolean => !!userId && userId.startsWith(BOT_PREFIX);
export const BOT_NAMES = ['🤖 Roboti', '🤖 Bardha', '🤖 Genci'];
/** Bot "thinking" delay before it acts, for a natural pace (ms). */
export const BOT_MIN_DELAY = 550;
export const BOT_MAX_DELAY = 1100;
