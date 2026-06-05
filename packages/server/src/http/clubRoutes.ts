// ============================================================================
// MURLAN — Club REST routes (social). Create / list / detail / join / leave.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth } from './authRoutes.ts';
import { ClubService, ClubError } from '../social/clubService.ts';
import type { ChatService } from '../chat/chatService.ts';

export interface ClubRoutesDeps {
  auth: AuthService;
  clubs: ClubService;
  chat?: ChatService; // club chat (membership-gated history + report + founder mute)
}

const createSchema = z.object({
  name: z.string().trim().min(3).max(32),
  tag: z.string().trim().min(2).max(5),
});
const reportSchema = z.object({ reason: z.string().trim().min(1).max(280) });
const founderMuteSchema = z.object({
  userId: z.string().min(1),
  durationMs: z.number().int().positive().max(30 * 24 * 60 * 60 * 1000).optional(), // default 24h
  reason: z.string().trim().max(280).optional(),
});

export async function clubRoutes(app: FastifyInstance, deps: ClubRoutesDeps): Promise<void> {
  const { auth, clubs } = deps;
  const guard = requireAuth(auth);
  const fail = (reply: any, e: unknown) => {
    if (e instanceof ClubError) return reply.code(e.code === 'no_club' ? 404 : 409).send({ error: { code: e.code, message: e.message } });
    throw e;
  };

  app.get('/api/clubs', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return reply.send({ clubs: await clubs.listClubs() });
  });

  app.get('/api/clubs/me', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return reply.send({ club: await clubs.getMyClub(caller.userId) });
  });

  app.get('/api/clubs/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const club = await clubs.getClub((req.params as { id: string }).id);
    if (!club) return reply.code(404).send({ error: { code: 'not_found', message: 'Klubi nuk u gjet.' } });
    return reply.send({ club });
  });

  app.post('/api/clubs', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna klubi të pavlefshme.' } });
    try {
      return reply.code(201).send({ club: await clubs.create(caller.userId, parsed.data.name, parsed.data.tag) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/clubs/:id/join', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    try {
      return reply.send({ club: await clubs.join(caller.userId, (req.params as { id: string }).id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/clubs/leave', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    try {
      return reply.send(await clubs.leave(caller.userId));
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ----- Club chat (membership-gated) ----------------------------------------
  if (deps.chat) {
    const chat = deps.chat;

    app.get('/api/clubs/:id/messages', async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      const messages = await chat.history(caller.userId, (req.params as { id: string }).id);
      if (messages === null) return reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm anëtarët shohin bisedën.' } });
      return reply.send({ messages });
    });

    app.post('/api/clubs/messages/:id/report', async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      const parsed = reportSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Arsye e pavlefshme.' } });
      const res = await chat.report(caller.userId, (req.params as { id: string }).id, parsed.data.reason);
      if (!res.ok) return reply.code(res.code === 'not_found' ? 404 : 403).send({ error: { code: res.code ?? 'error', message: 'Raportimi dështoi.' } });
      return reply.send({ ok: true });
    });

    // A club founder mutes a member of their own club (default 24h).
    app.post('/api/clubs/mute', async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      const parsed = founderMuteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme.' } });
      const res = await chat.founderMute(caller.userId, parsed.data.userId, parsed.data.durationMs ?? 24 * 60 * 60 * 1000, parsed.data.reason ?? '');
      if (!res.ok) return reply.code(res.code === 'forbidden' ? 403 : 409).send({ error: { code: res.code ?? 'error', message: 'Heshtja dështoi.' } });
      return reply.send({ ok: true });
    });
  }
}
