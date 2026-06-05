// ============================================================================
// MURLAN — Support / dispute ticket routes
// ----------------------------------------------------------------------------
// Players open tickets (and can attach a match id for a dispute) and see their
// own; admins triage all tickets and resolve them with a note — every resolution
// is also written to the immutable AdminAction audit trail. The ledger + audit
// trail are the evidence base for resolving a money dispute.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth, requireAdmin } from './authRoutes.ts';
import type { AdminAuditRepository } from '../auth/adminAudit.ts';
import type { SupportRepository } from '../support/supportRepository.ts';

export interface SupportRoutesDeps {
  auth: AuthService;
  support: SupportRepository;
  audit?: AdminAuditRepository;
}

const createSchema = z.object({
  category: z.enum(['match', 'payment', 'account', 'other']),
  subject: z.string().trim().min(3).max(120),
  message: z.string().trim().min(5).max(2000),
  matchId: z.string().trim().min(1).max(128).optional(),
});
const resolveSchema = z.object({
  status: z.enum(['resolved', 'closed']),
  adminNote: z.string().trim().max(2000).optional(),
});

export async function supportRoutes(app: FastifyInstance, deps: SupportRoutesDeps): Promise<void> {
  const { auth, support } = deps;
  const guard = requireAuth(auth);
  const admin = requireAdmin(auth);

  // ----- Player -------------------------------------------------------------
  app.post('/api/support/tickets', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme për tiketën.' } });
    const ticket = await support.create({ userId: caller.userId, ...parsed.data });
    return reply.code(201).send({ ticket });
  });

  app.get('/api/support/tickets', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return reply.send({ tickets: await support.listByUser(caller.userId) });
  });

  // ----- Admin --------------------------------------------------------------
  app.get('/api/admin/support', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    return reply.send({ tickets: await support.list(200) });
  });

  app.post('/api/admin/support/:id/resolve', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Zgjidhje e pavlefshme.' } });
    const { id } = req.params as { id: string };
    const existing = await support.get(id);
    if (!existing) return reply.code(404).send({ error: { code: 'not_found', message: 'Tiketa nuk u gjet.' } });
    const ticket = await support.resolve(id, parsed.data.status, parsed.data.adminNote ?? null, Date.now());
    // The resolution is an audited admin action (who/whom/why) — same rigor as money actions.
    await deps.audit?.record({
      adminId: caller.userId,
      action: 'support_resolve',
      targetUserId: existing.userId,
      detail: `ticket ${id} → ${parsed.data.status}${parsed.data.adminNote ? `: ${parsed.data.adminNote}` : ''}`,
    }).catch(() => undefined);
    return reply.send({ ticket });
  });
}
