import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { InMemoryClubRepository } from '../social/clubRepository.ts';
import { ClubService } from '../social/clubService.ts';

async function build() {
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const clubs = new ClubService(new InMemoryClubRepository(), repo);
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const app = await buildHttpApp({ auth, config, clubs });
  const p1 = await auth.register({ username: 'founder', email: 'f@x.com', password: 'password123' });
  const p2 = await auth.register({ username: 'joiner', email: 'j@x.com', password: 'password123' });
  return { app, t1: p1.tokens.accessToken, t2: p2.tokens.accessToken };
}
const h = (t: string) => ({ authorization: `Bearer ${t}` });

test('club routes: create → list → join → leave, with auth + error mapping', async () => {
  const { app, t1, t2 } = await build();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/clubs' })).statusCode, 401); // unauth

    const bad = await app.inject({ method: 'POST', url: '/api/clubs', headers: h(t1), payload: { name: 'x', tag: 'TST' } });
    assert.equal(bad.statusCode, 400); // name too short

    const created = await app.inject({ method: 'POST', url: '/api/clubs', headers: h(t1), payload: { name: 'Test Club', tag: 'tst' } });
    assert.equal(created.statusCode, 201);
    const id = created.json().club.id as string;
    assert.equal(created.json().club.tag, 'TST'); // upper-cased

    const list = await app.inject({ method: 'GET', url: '/api/clubs', headers: h(t1) });
    assert.equal(list.json().clubs.length, 1);
    assert.equal(list.json().clubs[0].memberCount, 1);

    // Founder can't create a second club.
    const dupe = await app.inject({ method: 'POST', url: '/api/clubs', headers: h(t1), payload: { name: 'Another', tag: 'AAA' } });
    assert.equal(dupe.statusCode, 409);
    assert.equal(dupe.json().error.code, 'already_in_club');

    const joined = await app.inject({ method: 'POST', url: `/api/clubs/${id}/join`, headers: h(t2) });
    assert.equal(joined.statusCode, 200);
    assert.equal(joined.json().club.memberCount, 2);

    const mine = await app.inject({ method: 'GET', url: '/api/clubs/me', headers: h(t2) });
    assert.equal(mine.json().club.id, id);

    assert.equal((await app.inject({ method: 'POST', url: '/api/clubs/leave', headers: h(t2) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/clubs/me', headers: h(t2) })).json().club, null);
  } finally {
    await app.close();
  }
});
