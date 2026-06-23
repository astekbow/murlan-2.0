// Regression: the public replay endpoint must NOT leak a LIVE match's move-log
// (the redacted card-switch tribute card + full live move sequence) — authz-8.
// Actions are withheld until the match revealed its seeds (mirrors the seed gate).

import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { replayRoutes } from './replayRoutes.ts';
import { InMemoryGames } from '../fair/gamesRepository.ts';
import { InMemoryMatchActions } from '../realtime/matchActions.ts';

async function buildApp(): Promise<{ app: FastifyInstance; games: InMemoryGames; matchLog: InMemoryMatchActions }> {
  const games = new InMemoryGames();
  const matchLog = new InMemoryMatchActions();
  const app = Fastify();
  await replayRoutes(app, { games, matchLog });
  await app.ready();
  return { app, games, matchLog };
}

async function seedMatch(games: InMemoryGames, matchLog: InMemoryMatchActions, matchId: string): Promise<void> {
  await games.recordGame({ matchId, index: 0, serverSeed: 'srv', serverSeedHash: 'hash', clientSeed: 'cli', nonce: 1 });
  // A 'switch' move carries the deliberately-hidden tribute card — the cheating edge.
  await matchLog.append({ matchId, seq: 0, gameIndex: 0, seat: 0, type: 'switch', cards: [{ kind: 'standard', rank: 'A', suit: 'S' }], at: 1 });
  await matchLog.append({ matchId, seq: 1, gameIndex: 0, seat: 1, type: 'play', cards: [{ kind: 'standard', rank: '3', suit: 'H' }], at: 2 });
}

test('replay: a LIVE (unrevealed) match serves NO move-log actions', async () => {
  const { app, games, matchLog } = await buildApp();
  await seedMatch(games, matchLog, 'm_live');
  const res = await app.inject({ method: 'GET', url: '/api/replay/m_live' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.revealed, false);
  assert.deepEqual(body.actions, []);          // no switch card / move-log leaked
  assert.equal(body.serverSeedHash, 'hash');   // the commitment hash is still public
  assert.equal(body.games[0].serverSeed, null); // serverSeed still withheld (existing gate)
  await app.close();
});

test('replay: a FINISHED (revealed) match serves the full move-log', async () => {
  const { app, games, matchLog } = await buildApp();
  await seedMatch(games, matchLog, 'm_done');
  await games.revealMatch('m_done');
  const res = await app.inject({ method: 'GET', url: '/api/replay/m_done' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.revealed, true);
  assert.equal(body.actions.length, 2);        // move-log public once revealed
  assert.equal(body.actions[0].type, 'switch');
  assert.equal(body.games[0].serverSeed, 'srv');
  await app.close();
});

test('replay: an unknown match id is 404', async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/replay/nope' });
  assert.equal(res.statusCode, 404);
  await app.close();
});
