// ============================================================================
// MURLAN — Replay route (public): a finished match's deal seeds + move-log.
// ----------------------------------------------------------------------------
// Combines the durable provably-fair seeds (which reproduce each deal) with the
// persisted move-log (every play/pass/switch in turn order) so any client — or a
// regulator resolving a dispute — can replay a match move-for-move. Server seeds
// are withheld until the match revealed them (same rule as the verify endpoint).
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { ReplayDTO } from '@murlan/shared';
import type { GamesRepository } from '../fair/gamesRepository.ts';
import type { MatchActionsRepository } from '../realtime/matchActions.ts';

export interface ReplayRoutesDeps {
  games: GamesRepository;
  matchLog: MatchActionsRepository;
}

export async function replayRoutes(app: FastifyInstance, deps: ReplayRoutesDeps): Promise<void> {
  app.get('/api/replay/:matchId', async (req, reply) => {
    const { matchId } = req.params as { matchId: string };
    const [games, actions] = await Promise.all([
      deps.games.listByMatch(matchId),
      deps.matchLog.listByMatch(matchId),
    ]);
    if (games.length === 0 && actions.length === 0) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Ndeshja nuk u gjet.' } });
    }
    const revealed = games.length > 0 && games.every((g) => g.revealed);
    // Every seated player plays cards to empty their hand, so the highest seat in
    // the move-log is numPlayers-1 for a completed match.
    const numPlayers = actions.reduce((max, a) => Math.max(max, a.seat + 1), 0);

    const dto: ReplayDTO = {
      matchId,
      revealed,
      numPlayers,
      serverSeedHash: games[0]?.serverSeedHash ?? null,
      clientSeed: games[0]?.clientSeed ?? null,
      games: games.map((g) => ({
        index: g.index,
        nonce: g.nonce,
        revealed: g.revealed,
        serverSeed: g.revealed ? g.serverSeed : null,
      })),
      actions: actions.map((a) => ({ seq: a.seq, gameIndex: a.gameIndex, seat: a.seat, type: a.type, cards: a.cards })),
    };
    return reply.send(dto);
  });
}
