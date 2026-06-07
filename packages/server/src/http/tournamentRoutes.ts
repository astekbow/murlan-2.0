// ============================================================================
// MURLAN — Tournament REST routes
// ----------------------------------------------------------------------------
// Players list/view/register (register escrows the buy-in via TournamentService).
// Admin creates, reports a pairing result (advances the bracket; the final pays
// out pool − rake), or cancels (refunds every buy-in). The money math lives in
// TournamentService (unit-tested); these are thin, auth-gated handlers.
// ============================================================================

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth, requireAdmin } from './authRoutes.ts';
import { TournamentService, TournamentError } from '../tournament/tournamentService.ts';
import { InsufficientFundsError } from '../money/walletService.ts';

export interface TournamentRoutesDeps {
  auth: AuthService;
  tournaments: TournamentService;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  buyInCents: z.number().int().min(0).max(1_000_000_00),
  capacity: z.union([z.literal(2), z.literal(4), z.literal(8)]),
});

export async function tournamentRoutes(app: FastifyInstance, deps: TournamentRoutesDeps): Promise<void> {
  const { auth, tournaments } = deps;
  const guard = requireAuth(auth);
  const admin = requireAdmin(auth);

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof InsufficientFundsError) return reply.code(402).send({ error: { code: 'insufficient_funds', message: 'Fonde të pamjaftueshme.' } });
    if (e instanceof TournamentError) return reply.code(e.code === 'not_found' ? 404 : 409).send({ error: { code: e.code, message: e.message } });
    throw e;
  };

  app.get('/api/tournaments', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return reply.send({ tournaments: await tournaments.list() });
  });

  app.get('/api/tournaments/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const t = await tournaments.get((req.params as { id: string }).id);
    if (!t) return reply.code(404).send({ error: { code: 'not_found', message: 'Turneu nuk u gjet.' } });
    return reply.send({ tournament: t });
  });

  app.post('/api/tournaments/:id/register', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    try {
      return reply.send({ tournament: await tournaments.register((req.params as { id: string }).id, caller.userId) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ----- Admin: create / report a pairing winner / cancel(+refund) -----------
  app.post('/api/tournaments', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna turneu të pavlefshme.' } });
    try {
      return reply.code(201).send({ tournament: await tournaments.create(parsed.data.name, parsed.data.buyInCents, parsed.data.capacity) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/tournaments/:id/report', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    const b = (req.body ?? {}) as { round?: unknown; index?: unknown; winnerId?: unknown };
    if (typeof b.round !== 'number' || typeof b.index !== 'number' || typeof b.winnerId !== 'string') {
      return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme.' } });
    }
    try {
      return reply.send({ tournament: await tournaments.reportResult((req.params as { id: string }).id, b.round, b.index, b.winnerId) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/tournaments/:id/cancel', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    try {
      return reply.send({ tournament: await tournaments.cancel((req.params as { id: string }).id) });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
