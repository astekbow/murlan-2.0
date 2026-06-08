// ============================================================================
// MURLAN — Rewards REST routes (Phase 6, §2.6). XP/cosmetic only — no money.
// All mutating routes 403 when rewards are disabled (per-jurisdiction switch).
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService.ts';
import type { RewardsService } from '../rewards/rewardsService.ts';
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';
import { checkRealMoneyAccess } from '../compliance/realMoneyGate.ts';
import { requireAuth } from './authRoutes.ts';

export interface RewardsRoutesDeps {
  auth: AuthService;
  rewards: RewardsService;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService;
}

export async function rewardsRoutes(app: FastifyInstance, deps: RewardsRoutesDeps): Promise<void> {
  const { auth, rewards } = deps;
  const guard = requireAuth(auth);
  const disabled = (reply: import('fastify').FastifyReply) =>
    reply.code(403).send({ error: { code: 'rewards_disabled', message: 'Shpërblimet janë çaktivizuar.' } });

  app.get('/api/rewards', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const status = await rewards.status(caller.userId, Date.now());
    if (!status) return reply.code(404).send({ error: { code: 'not_found', message: 'Profili nuk u gjet.' } });
    return { status };
  });

  app.post('/api/rewards/daily', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!rewards.enabled) return disabled(reply);
    const res = await rewards.claimDaily(caller.userId, Date.now());
    if (!res) return reply.code(409).send({ error: { code: 'already_claimed', message: 'E ke marrë sot.' } });
    return res;
  });

  app.post('/api/rewards/challenge/:id', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!rewards.enabled) return disabled(reply);
    const { id } = req.params as { id: string };
    const res = await rewards.claimChallenge(caller.userId, id);
    if (!res) return reply.code(409).send({ error: { code: 'not_claimable', message: 'Nuk mund të merret.' } });
    return res;
  });

  app.post('/api/shop/buy', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!rewards.enabled) return disabled(reply);
    const { id } = (req.body ?? {}) as { id?: string };
    // The shop spends real wallet money, so it's a real-money entry point: enforce
    // the account-state + compliance gates (a banned/frozen/self-excluded account
    // can't spend). No loss-cap — a cosmetic purchase isn't a gambling wager.
    const gate = await checkRealMoneyAccess({ auth, compliance: deps.compliance, rg: deps.rg }, caller.userId);
    if (!gate.allowed) return reply.code(403).send({ error: { code: gate.code ?? 'blocked', message: gate.message ?? 'Bllokuar.' } });
    const res = await rewards.buy(caller.userId, String(id));
    if (!res.ok) {
      if (res.code === 'insufficient_funds') return reply.code(402).send({ error: { code: 'insufficient_funds', message: 'Fonde të pamjaftueshme.' } });
      return reply.code(400).send({ error: { code: res.code ?? 'failed', message: 'Blerja dështoi.' } });
    }
    return { ok: true };
  });

  app.post('/api/cosmetics/equip', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!rewards.enabled) return disabled(reply);
    const { id } = (req.body ?? {}) as { id?: string };
    const res = await rewards.equip(caller.userId, String(id));
    if (!res.ok) return reply.code(400).send({ error: { code: res.code ?? 'failed', message: 'Veshja dështoi.' } });
    return { ok: true };
  });
}
