// ============================================================================
// MURLAN — Social REST routes (Phase 5): public profiles, leaderboard, friends.
// Cosmetic/progression + social only. No money or game endpoints here.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService.ts';
import type { ProfileService } from '../profile/profileService.ts';
import { AVATARS } from '../profile/profileService.ts';
import { FriendsService, FriendsError } from '../social/friendsService.ts';
import type { FeedService } from '../social/feedService.ts';
import type { DmService } from '../social/dmService.ts';
import { requireAuth } from './authRoutes.ts';

export interface SocialRoutesDeps {
  auth: AuthService;
  profiles: ProfileService;
  friends: FriendsService;
  feed?: FeedService; // friend activity feed (optional — empty feed if absent)
  dms?: DmService;    // direct messages between friends (optional)
}

export async function socialRoutes(app: FastifyInstance, deps: SocialRoutesDeps): Promise<void> {
  const { auth, profiles, friends } = deps;
  const guard = requireAuth(auth);

  // The cosmetic avatar set (so the client can render the picker from one source).
  app.get('/api/avatars', async () => ({ avatars: AVATARS }));

  // Public profile of any user.
  app.get('/api/profile/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const profile = await profiles.getProfile(userId);
    if (!profile) return reply.code(404).send({ error: { code: 'not_found', message: 'Profili nuk u gjet.' } });
    return { profile };
  });

  // Own profile.
  app.get('/api/me/profile', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const profile = await profiles.getProfile(caller.userId);
    if (!profile) return reply.code(404).send({ error: { code: 'not_found', message: 'Profili nuk u gjet.' } });
    return { profile };
  });

  // Set a cosmetic avatar.
  app.post('/api/me/avatar', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const { avatar } = (req.body ?? {}) as { avatar?: string };
    try {
      const profile = await profiles.setAvatar(caller.userId, String(avatar));
      return { profile };
    } catch {
      return reply.code(400).send({ error: { code: 'invalid_avatar', message: 'Avatar i pavlefshëm.' } });
    }
  });

  // Leaderboard (global, by XP). Client highlights the viewer's own row. Limit 100 so the
  // ~100 demo players (when DEMO_LEADERBOARD is on) actually fill the board. (The ranked
  // leaderboard is separate and unchanged.)
  app.get('/api/leaderboard', async () => {
    return { rows: await profiles.leaderboard(100) };
  });

  // Username SEARCH for friend discovery (miqt). Auth-guarded; requires q ≥ 2 chars;
  // returns a MINIMAL public shape (id/username/avatar/level) — never email/stats. This
  // intentionally lets a player discover usernames (that is the point of a search); the
  // friend-request flow still validates the actual relationship server-side.
  app.get('/api/users/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } } }, async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const { q } = (req.query ?? {}) as { q?: string };
    const needle = (q ?? '').trim();
    if (needle.length < 2) return { users: [] }; // too short → no enumeration of single chars
    const users = await profiles.searchUsers(needle, 20, caller.userId);
    return { users };
  });

  // ----- Friends ------------------------------------------------------------
  app.get('/api/friends', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return { friends: await friends.list(caller.userId) };
  });

  // Friend activity feed: recent real-money wins by the caller's accepted friends.
  app.get('/api/friends/feed', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.feed) return reply.send({ feed: [] });
    const entries = await friends.list(caller.userId).catch(() => []);
    const friendIds = new Set(entries.filter((e) => e.direction === 'friends').map((e) => e.user.id));
    return reply.send({ feed: deps.feed.forFriends(friendIds) });
  });

  // ---- Direct messages (friends-only 1:1) ---------------------------------
  // Per-friend unread counts (for badges).
  app.get('/api/dm/unread', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.dms) return reply.send({ unread: {} });
    return reply.send({ unread: await deps.dms.unread(caller.userId) });
  });

  // The conversation with a friend (opening it marks the caller's side read).
  app.get('/api/dm/:userId', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.dms) return reply.send({ messages: [] });
    const { userId } = req.params as { userId: string };
    const messages = await deps.dms.conversation(caller.userId, userId, Date.now());
    if (messages === null) return reply.code(403).send({ error: { code: 'not_friends', message: 'S’jeni miq.' } });
    return reply.send({ messages });
  });

  // Send a DM to a friend.
  app.post('/api/dm/:userId', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.dms) return reply.code(409).send({ error: { code: 'disabled', message: 'Mesazhet s’janë aktive.' } });
    const { userId } = req.params as { userId: string };
    const { text } = (req.body ?? {}) as { text?: string };
    const dto = await deps.dms.send(caller.userId, userId, String(text ?? ''));
    if (!dto) return reply.code(400).send({ error: { code: 'send_failed', message: 'Mesazhi s’u dërgua dot (duhet të jeni miq).' } });
    return reply.send({ message: dto });
  });

  app.post('/api/friends/request', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const { username } = (req.body ?? {}) as { username?: string };
    if (!username) return reply.code(400).send({ error: { code: 'bad_request', message: 'Mungon përdoruesi.' } });
    try {
      await friends.requestByUsername(caller.userId, username);
      return { ok: true };
    } catch (e) {
      if (e instanceof FriendsError) return reply.code(400).send({ error: { code: e.code, message: e.message } });
      throw e;
    }
  });

  app.post('/api/friends/:id/respond', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { accept?: unknown };
    if (typeof body.accept !== 'boolean') {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Fusha "accept" duhet të jetë true/false.' } });
    }
    // respond returns null when the request is unknown / not addressed to this
    // user / no longer pending — surface that as 404 (for BOTH accept and decline)
    // instead of a misleading ok, so a stale decline isn't silently masked.
    const row = await friends.respond(caller.userId, id, body.accept);
    if (!row) {
      return reply.code(404).send({ error: { code: 'not_actionable', message: 'Kërkesa nuk u gjet ose nuk është për ty.' } });
    }
    return { ok: true };
  });

  app.delete('/api/friends/:id', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const { id } = req.params as { id: string };
    const removed = await friends.remove(caller.userId, id);
    return { ok: removed };
  });

  // Block / unblock by target USER id (works even if not currently friends).
  app.post('/api/friends/:id/block', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const { id } = req.params as { id: string };
    try {
      await friends.block(caller.userId, id);
      return { ok: true };
    } catch (e) {
      if (e instanceof FriendsError) return reply.code(400).send({ error: { code: e.code, message: e.message } });
      throw e;
    }
  });

  app.post('/api/friends/:id/unblock', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const { id } = req.params as { id: string };
    await friends.unblock(caller.userId, id);
    return { ok: true };
  });
}
