// ============================================================================
// MURLAN — Account self-service routes (Phase 7, compliance data)
// ----------------------------------------------------------------------------
// Players supply the data the compliance switches evaluate: date of birth and
// country (for age/geo gating) and can self-exclude (responsible gaming). KYC
// status itself is set by an admin (see adminRoutes).
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth } from './authRoutes.ts';

export interface AccountRoutesDeps {
  auth: AuthService;
}

const profileSchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Kod vendi i pavlefshëm.').optional(),
});
const selfExcludeSchema = z.object({ days: z.number().int().positive().max(3650) });

export async function accountRoutes(app: FastifyInstance, deps: AccountRoutesDeps): Promise<void> {
  const guard = requireAuth(deps.auth);

  app.get('/api/account', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const profile = await deps.auth.getComplianceProfile(caller.userId);
    if (!profile) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    return reply.send({ profile });
  });

  app.post('/api/account/profile', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna profili të pavlefshme.' } });

    // Age/geo gating must not sit on freely-mutable data: once KYC is VERIFIED the
    // declared DOB/country are locked (a verified user changing them to dodge a
    // gate must go through KYC again). Before verification they remain editable.
    const current = await deps.auth.getComplianceProfile(caller.userId);
    if (current?.kycStatus === 'verified') {
      const changingDob = parsed.data.dateOfBirth !== undefined && parsed.data.dateOfBirth !== current.dateOfBirth;
      const changingCountry =
        parsed.data.country !== undefined && parsed.data.country.toUpperCase() !== (current.country ?? null);
      if (changingDob || changingCountry) {
        return reply.code(409).send({
          error: { code: 'kyc_locked', message: 'Data e lindjes dhe vendi nuk ndryshohen pas verifikimit (KYC).' },
        });
      }
    }

    const updated = await deps.auth.updateCompliance(caller.userId, {
      dateOfBirth: parsed.data.dateOfBirth,
      country: parsed.data.country?.toUpperCase(),
    });
    return reply.send({ user: updated });
  });

  app.post('/api/account/self-exclude', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = selfExcludeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Numër ditësh i pavlefshëm.' } });
    const requested = Date.now() + parsed.data.days * 24 * 60 * 60 * 1000;
    // Self-exclusion can only be EXTENDED, never shortened or cancelled.
    const current = (await deps.auth.getComplianceProfile(caller.userId))?.selfExcludedUntil ?? 0;
    const until = Math.max(current, requested);
    await deps.auth.updateCompliance(caller.userId, { selfExcludedUntil: until });
    return reply.send({ ok: true, selfExcludedUntil: until });
  });
}
