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
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';
import type { AdminAuditRepository } from '../auth/adminAudit.ts';
import { checkRealMoneyAccess } from '../compliance/realMoneyGate.ts';
import { requireAuth, requireAdmin } from './authRoutes.ts';
import { TournamentService, TournamentError } from '../tournament/tournamentService.ts';
import { InsufficientFundsError } from '../money/walletService.ts';

export interface TournamentRoutesDeps {
  auth: AuthService;
  tournaments: TournamentService;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService;
  audit?: AdminAuditRepository; // append-only trail for admin create/report/cancel
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
    const id = (req.params as { id: string }).id;
    const t = await tournaments.get(id);
    if (!t) return reply.code(404).send({ error: { code: 'not_found', message: 'Turneu nuk u gjet.' } });
    // A paid buy-in is a real-money wager → enforce the same gates as a staked match
    // (account-state + compliance + daily loss cap). Free tournaments skip the gate.
    if (t.buyInCents > 0) {
      const gate = await checkRealMoneyAccess({ auth, compliance: deps.compliance, rg: deps.rg }, caller.userId, { checkLoss: true });
      if (!gate.allowed) return reply.code(403).send({ error: { code: gate.code ?? 'blocked', message: gate.message ?? 'Bllokuar.' } });
    }
    try {
      return reply.send({ tournament: await tournaments.register(id, caller.userId) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ----- Admin: create / report a pairing winner / cancel(+refund) -----------
  // Every admin action is recorded to the append-only audit trail (WHO did WHAT),
  // since reporting a winner moves a real prize pool (audit 2026-06-08, finding H4).
  app.post('/api/tournaments', async (req, reply) => {
    const adminCaller = await admin(req, reply);
    if (!adminCaller) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna turneu të pavlefshme.' } });
    try {
      const t = await tournaments.create(parsed.data.name, parsed.data.buyInCents, parsed.data.capacity);
      await deps.audit?.record({ adminId: adminCaller.userId, action: 'tournament_create', detail: `${t.id} "${t.name}" buyIn=${t.buyInCents} cap=${t.capacity}` }).catch(() => undefined);
      return reply.code(201).send({ tournament: t });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/tournaments/:id/report', async (req, reply) => {
    const adminCaller = await admin(req, reply);
    if (!adminCaller) return;
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as { round?: unknown; index?: unknown; winnerId?: unknown };
    if (typeof b.round !== 'number' || typeof b.index !== 'number' || typeof b.winnerId !== 'string') {
      return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme.' } });
    }
    try {
      const t = await tournaments.reportResult(id, b.round, b.index, b.winnerId, adminCaller.userId);
      const paidPrize = t.status === 'finished' ? t.prizePoolCents - Math.floor((t.prizePoolCents * t.rakeBps) / 10000) : null;
      const tail = t.status === 'finished' ? ' CHAMPION' : t.status === 'awaiting_confirmation' ? ' AWAITING-CONFIRM' : '';
      await deps.audit?.record({
        adminId: adminCaller.userId, action: 'tournament_report', targetUserId: b.winnerId,
        amountCents: paidPrize, detail: `${id} r${b.round}#${b.index} winner=${b.winnerId}${tail}`,
      }).catch(() => undefined);
      return reply.send({ tournament: t });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Dual-control: a SECOND, distinct admin confirms a parked champion → triggers the
  // payout. Only meaningful when dual-control is enabled (TOURNAMENT_DUAL_CONTROL); with
  // it off, a final never enters 'awaiting_confirmation' so this returns not_awaiting.
  app.post('/api/tournaments/:id/confirm', async (req, reply) => {
    const adminCaller = await admin(req, reply);
    if (!adminCaller) return;
    const id = (req.params as { id: string }).id;
    try {
      const t = await tournaments.confirmChampion(id, adminCaller.userId);
      const paidPrize = t.status === 'finished' ? t.prizePoolCents - Math.floor((t.prizePoolCents * t.rakeBps) / 10000) : null;
      await deps.audit?.record({
        adminId: adminCaller.userId, action: 'tournament_confirm', targetUserId: t.winnerId,
        amountCents: paidPrize, detail: `${id} confirmed champion=${t.winnerId} CHAMPION`,
      }).catch(() => undefined);
      return reply.send({ tournament: t });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/tournaments/:id/cancel', async (req, reply) => {
    const adminCaller = await admin(req, reply);
    if (!adminCaller) return;
    const id = (req.params as { id: string }).id;
    try {
      const t = await tournaments.cancel(id);
      await deps.audit?.record({ adminId: adminCaller.userId, action: 'tournament_cancel', detail: `${id} refunded ${t.playerIds.length} player(s)` }).catch(() => undefined);
      return reply.send({ tournament: t });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
