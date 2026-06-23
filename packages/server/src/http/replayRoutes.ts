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

// Max actions returned per response. A finished Murlan match's move-log is small, but
// this caps the unbounded read on a PUBLIC (unauthenticated, by design) endpoint and
// makes a hostile/corrupt match id harmless. Clients page with ?afterSeq=<cursor>.
const ACTIONS_PAGE = 1000;

export async function replayRoutes(app: FastifyInstance, deps: ReplayRoutesDeps): Promise<void> {
  // The replay/verifier is intentionally PUBLIC (a shared ?replay=<id> link must open
  // for anyone, signed in or not — provably-fair transparency), so we DON'T add auth.
  // Instead bound it: a per-IP rate limit + paginated actions (below) stop a flood / an
  // unbounded scan. (Per-route rate limit applies only when the global plugin is registered.)
  app.get('/api/replay/:matchId', { config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req) => req.ip } } }, async (req, reply) => {
    const { matchId } = req.params as { matchId: string };
    const afterSeqRaw = Number((req.query as { afterSeq?: string }).afterSeq);
    const afterSeq = Number.isFinite(afterSeqRaw) ? afterSeqRaw : -1;
    const [games, actions] = await Promise.all([
      deps.games.listByMatch(matchId),
      deps.matchLog.listByMatch(matchId),
    ]);
    if (games.length === 0 && actions.length === 0) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Ndeshja nuk u gjet.' } });
    }
    const revealed = games.length > 0 && games.every((g) => g.revealed);
    // numPlayers is derived from the FULL move-log (the highest seat) so deal
    // reconstruction stays correct even when a page omits later actions.
    const numPlayers = actions.reduce((max, a) => Math.max(max, a.seat + 1), 0);
    // Keyset page: actions strictly after the cursor seq, capped at ACTIONS_PAGE.
    const pageRows = actions.filter((a) => a.seq > afterSeq).slice(0, ACTIONS_PAGE);
    const lastSeq = actions.length ? actions[actions.length - 1]!.seq : -1;
    const nextActionCursor = pageRows.length && pageRows[pageRows.length - 1]!.seq < lastSeq
      ? pageRows[pageRows.length - 1]!.seq
      : null;

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
      actions: pageRows.map((a) => ({ seq: a.seq, gameIndex: a.gameIndex, seat: a.seat, type: a.type, cards: a.cards })),
    };
    // nextActionCursor is an additive paging hint (seq of the last returned action when
    // more remain; null otherwise). Sent alongside the DTO — clients page via ?afterSeq=.
    return reply.send({ ...dto, nextActionCursor });
  });
}
