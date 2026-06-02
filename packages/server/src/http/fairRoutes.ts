// ============================================================================
// MURLAN — Provably-fair verification route (public)
// ----------------------------------------------------------------------------
// Anyone (player or regulator) can fetch a finished match's committed hash,
// client seed, and — once revealed — the server seed + per-game nonces, then
// recompute every deal and check it against the commitment. Durable: served
// from persisted Game rows, so it works even after a restart or if the player
// was disconnected at the reveal. The serverSeed is withheld until revealed.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { GamesRepository } from '../fair/gamesRepository.ts';

export interface FairRoutesDeps {
  games: GamesRepository;
}

export async function fairRoutes(app: FastifyInstance, deps: FairRoutesDeps): Promise<void> {
  app.get('/api/fair/match/:matchId', async (req, reply) => {
    const { matchId } = req.params as { matchId: string };
    const games = await deps.games.listByMatch(matchId);
    if (games.length === 0) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Ndeshja nuk u gjet.' } });
    }
    const revealed = games.every((g) => g.revealed);
    return reply.send({
      matchId,
      revealed,
      serverSeedHash: games[0].serverSeedHash,
      clientSeed: games[0].clientSeed,
      // serverSeed is published per game ONLY after the match revealed it.
      games: games.map((g) => ({
        index: g.index,
        nonce: g.nonce,
        revealed: g.revealed,
        serverSeed: g.revealed ? g.serverSeed : null,
      })),
    });
  });
}
