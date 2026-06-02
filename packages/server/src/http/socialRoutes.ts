// ============================================================================
// MURLAN — Social REST routes (Phase 5): public profiles, leaderboard, friends.
// Cosmetic/progression + social only. No money or game endpoints here.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService.ts';
import type { ProfileService } from '../profile/profileService.ts';
import { AVATARS } from '../profile/profileService.ts';
import { FriendsService, FriendsError } from '../social/friendsService.ts';
import { requireAuth } from './authRoutes.ts';

export interface SocialRoutesDeps {
  auth: AuthService;
  profiles: ProfileService;
  friends: FriendsService;
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

  // Leaderboard (global, by XP). Client highlights the viewer's own row.
  app.get('/api/leaderboard', async () => {
    return { rows: await profiles.leaderboard(50) };
  });

  // ----- Friends ------------------------------------------------------------
  app.get('/api/friends', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return { friends: await friends.list(caller.userId) };
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
    // user / no longer pending — surface that as 404 instead of a misleading ok.
    const row = await friends.respond(caller.userId, id, body.accept);
    if (body.accept && !row) {
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
