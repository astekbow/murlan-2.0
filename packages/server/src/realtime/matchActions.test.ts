import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { InMemoryGames } from '../fair/gamesRepository.ts';
import { InMemoryMatchActions } from './matchActions.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

test('InMemoryMatchActions: lists in seq order regardless of append order; idempotent on (matchId,seq)', async () => {
  const repo = new InMemoryMatchActions();
  await repo.append({ matchId: 'm1', seq: 2, gameIndex: 1, seat: 0, type: 'pass', cards: null, at: 30 });
  await repo.append({ matchId: 'm1', seq: 0, gameIndex: 0, seat: 0, type: 'play', cards: [c('3', 'S')], at: 10 });
  await repo.append({ matchId: 'm1', seq: 1, gameIndex: 0, seat: 1, type: 'play', cards: [c('4', 'S')], at: 20 });
  await repo.append({ matchId: 'm1', seq: 0, gameIndex: 0, seat: 0, type: 'play', cards: [c('9', 'H')], at: 99 }); // dup seq → ignored
  await repo.append({ matchId: 'm2', seq: 0, gameIndex: 0, seat: 0, type: 'play', cards: [c('5', 'C')], at: 5 });

  const m1 = await repo.listByMatch('m1');
  assert.deepEqual(m1.map((a) => a.seq), [0, 1, 2]); // sorted, dup dropped
  assert.deepEqual(m1[0]!.cards, [c('3', 'S')]); // first write wins for the dup seq
  assert.equal(m1[2]!.type, 'pass');
  assert.equal((await repo.listByMatch('m2')).length, 1); // matches are isolated
  assert.deepEqual(await repo.listByMatch('nope'), []);
});

test('InMemoryMatchActions: deleteOlderThan prunes by timestamp (data retention)', async () => {
  const repo = new InMemoryMatchActions();
  await repo.append({ matchId: 'old', seq: 0, gameIndex: 0, seat: 0, type: 'play', cards: [c('3', 'S')], at: 100 });
  await repo.append({ matchId: 'mix', seq: 0, gameIndex: 0, seat: 0, type: 'play', cards: [c('4', 'S')], at: 100 }); // pruned
  await repo.append({ matchId: 'mix', seq: 1, gameIndex: 0, seat: 1, type: 'pass', cards: null, at: 500 });          // kept
  await repo.append({ matchId: 'new', seq: 0, gameIndex: 0, seat: 0, type: 'play', cards: [c('5', 'S')], at: 900 });

  const removed = await repo.deleteOlderThan(300); // drop everything recorded before t=300
  assert.equal(removed, 2);
  assert.deepEqual(await repo.listByMatch('old'), []);          // fully pruned → match dropped
  assert.deepEqual((await repo.listByMatch('mix')).map((a) => a.seq), [1]); // only the recent move remains
  assert.equal((await repo.listByMatch('new')).length, 1);      // newer than the cutoff → untouched
});

async function buildApp() {
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const games = new InMemoryGames();
  const matchLog = new InMemoryMatchActions();
  const app = await buildHttpApp({ auth, config, games, matchLog });
  return { app, games, matchLog };
}

test('GET /api/replay/:matchId returns the deal seeds + move-log; 404 for an unknown match', async () => {
  const { app, games, matchLog } = await buildApp();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/replay/unknown' })).statusCode, 404);

    await games.recordGame({ matchId: 'm1', index: 0, serverSeed: 'ss0', serverSeedHash: 'hash', clientSeed: 'cs', nonce: 0 });
    await matchLog.append({ matchId: 'm1', seq: 0, gameIndex: 0, seat: 0, type: 'play', cards: [c('3', 'S')], at: 1 });
    await matchLog.append({ matchId: 'm1', seq: 1, gameIndex: 0, seat: 1, type: 'pass', cards: null, at: 2 });

    const before = await app.inject({ method: 'GET', url: '/api/replay/m1' });
    assert.equal(before.statusCode, 200);
    const dto = before.json();
    assert.equal(dto.matchId, 'm1');
    assert.equal(dto.revealed, false);
    assert.equal(dto.numPlayers, 2); // max seat (1) + 1
    assert.equal(dto.serverSeedHash, 'hash');
    assert.equal(dto.games[0].serverSeed, null); // withheld until revealed
    // authz-8: a LIVE (unrevealed) match leaks NO move-log (the switch/tribute card is the
    // cheating edge) — actions are withheld until reveal, mirroring the serverSeed gate.
    assert.deepEqual(dto.actions, []);

    await games.revealMatch('m1');
    const after = (await app.inject({ method: 'GET', url: '/api/replay/m1' })).json();
    assert.equal(after.revealed, true);
    assert.equal(after.games[0].serverSeed, 'ss0'); // published once revealed
    // Once revealed, the full move-log is public for provably-fair replay.
    assert.deepEqual(after.actions.map((a: any) => a.seq), [0, 1]);
    assert.deepEqual(after.actions[0].cards, [c('3', 'S')]);
    assert.equal(after.actions[1].cards, null);
  } finally {
    await app.close();
  }
});
