// ============================================================================
// MURLAN — Ranked REST routes: seasons, MMR, tiers, ranked leaderboard.
// Competitive/cosmetic only — no money or game state here. Reads are public so
// the ladder/leaderboard render without auth; /me needs a session; opening a
// season is admin-only.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth, requireAdmin } from './authRoutes.ts';
import type { RankedService } from '../ranked/rankedService.ts';

export interface RankedRoutesDeps {
  auth: AuthService;
  ranked: RankedService;
}

const createSeasonSchema = z.object({
  name: z.string().min(1).max(60),
  decayFactor: z.number().min(0).max(1).optional(),
});

export async function rankedRoutes(app: FastifyInstance, deps: RankedRoutesDeps): Promise<void> {
  const { auth, ranked } = deps;
  const guard = requireAuth(auth);
  const admin = requireAdmin(auth);

  // The full tier ladder (for badges + reward preview). Static, public.
  app.get('/api/ranked/tiers', async () => ({ tiers: ranked.tiers() }));

  // The active season (null when ranked is off / no season opened yet). Public.
  app.get('/api/ranked/season', async () => ({ season: await ranked.getActiveSeason() }));

  // Top players in the active season. Public; the client highlights its own row.
  app.get('/api/ranked/leaderboard', async () => ({ rows: await ranked.leaderboard(50) }));

  // The viewer's own ranked standing in the active season.
  app.get('/api/ranked/me', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return { ranked: await ranked.getUserRanked(caller.userId) };
  });

  // Open a new season (archives the current one + soft-resets ratings). Admin.
  app.post('/api/admin/ranked/season', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const parsed = createSeasonSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme për sezonin.' } });
    }
    const season = await ranked.createSeason(parsed.data.name, parsed.data.decayFactor);
    return reply.send({ season });
  });
}
