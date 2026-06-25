// ============================================================================
// MURLAN — VIP / loyalty routes (status + the free weekly cosmetic gift)
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth } from './authRoutes.ts';
import type { VipService } from '../vip/vipService.ts';
import type { RewardsService } from '../rewards/rewardsService.ts';

export interface VipRoutesDeps {
  auth: AuthService;
  vip: VipService;
  rewards?: RewardsService; // optional: no rewards module ⇒ no weekly gift
}

export async function vipRoutes(app: FastifyInstance, deps: VipRoutesDeps): Promise<void> {
  const guard = requireAuth(deps.auth);

  // The VIP tier ladder (static, public — for the client to render perks/progress).
  app.get('/api/vip/tiers', async () => ({ tiers: deps.vip.tiers() }));

  // The viewer's own VIP status (tier + loyalty + progress) + whether a free weekly gift is
  // claimable (bronze+ and not already taken this ISO-week).
  app.get('/api/vip', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const status = await deps.vip.getStatus(caller.userId);
    const isVip = status.tier.key !== 'standard';
    const giftAvailable = isVip && !!deps.rewards && await deps.rewards.isVipGiftAvailable(caller.userId, Date.now());
    return reply.send({ vip: { ...status, giftAvailable } });
  });

  // Claim the free weekly VIP cosmetic gift (bronze+, once per ISO-week). The tier is derived
  // from staked volume server-side — the client can't grant itself a gift.
  app.post('/api/vip/weekly-gift', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.rewards) return reply.code(409).send({ error: 'disabled' });
    const status = await deps.vip.getStatus(caller.userId);
    const isVip = status.tier.key !== 'standard';
    const res = await deps.rewards.claimVipGift(caller.userId, { isVip, now: Date.now() });
    if (!res.ok) return reply.code(409).send({ error: res.code });
    return reply.send(res);
  });
}
