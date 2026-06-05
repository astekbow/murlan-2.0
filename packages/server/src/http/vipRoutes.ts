// ============================================================================
// MURLAN — VIP / loyalty routes (status only; rake-back cashout is payment-gated)
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth } from './authRoutes.ts';
import type { VipService } from '../vip/vipService.ts';

export interface VipRoutesDeps {
  auth: AuthService;
  vip: VipService;
}

export async function vipRoutes(app: FastifyInstance, deps: VipRoutesDeps): Promise<void> {
  const guard = requireAuth(deps.auth);

  // The VIP tier ladder (static, public — for the client to render perks/progress).
  app.get('/api/vip/tiers', async () => ({ tiers: deps.vip.tiers() }));

  // The viewer's own VIP status (tier + loyalty + progress to next tier).
  app.get('/api/vip', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return reply.send({ vip: await deps.vip.getStatus(caller.userId) });
  });
}
