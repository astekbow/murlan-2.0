// Club tournaments — route-level gating (founder-only create, members-only register/list,
// global list excludes club ones). Free buy-ins (buyInCents 0) so the real-money gate
// (which needs compliance wiring) doesn't fire — the club gates are what's under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { InMemoryClubRepository } from '../social/clubRepository.ts';
import { ClubService } from '../social/clubService.ts';
import { TournamentService, InMemoryTournamentRepository, type TournamentWallet } from '../tournament/tournamentService.ts';

// No-op wallet — club tournaments under test use free buy-ins, so no money moves.
const noopWallet: TournamentWallet = {
  async debit() {},
  async credit() {},
  async recordRake() {},
  async payoutChampion() {},
};

async function build() {
  const repo = new InMemoryUserRepository();
  const auth = new AuthService(repo, new TokenService({ accessSecret: 'a', refreshSecret: 'r' }));
  const clubs = new ClubService(new InMemoryClubRepository(), repo);
  const tournaments = new TournamentService(new InMemoryTournamentRepository(), noopWallet, 1000);
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const app = await buildHttpApp({ auth, config, clubs, tournaments });
  // founder creates a club; member joins; outsider stays clubless.
  const founder = await auth.register({ username: 'founder', email: 'f@x.com', password: 'password123' });
  const member = await auth.register({ username: 'member', email: 'm@x.com', password: 'password123' });
  const outsider = await auth.register({ username: 'outsider', email: 'o@x.com', password: 'password123' });
  const tF = founder.tokens.accessToken, tM = member.tokens.accessToken, tO = outsider.tokens.accessToken;
  const created = await app.inject({ method: 'POST', url: '/api/clubs', headers: h(tF), payload: { name: 'Test Club', tag: 'TST' } });
  const clubId = created.json().club.id as string;
  await app.inject({ method: 'POST', url: `/api/clubs/${clubId}/join`, headers: h(tM) });
  return { app, tF, tM, tO, clubId };
}
const h = (t: string) => ({ authorization: `Bearer ${t}` });

test('club tournaments: only the founder can create one', async () => {
  const { app, tF, tM, clubId } = await build();
  try {
    // A non-founder member is forbidden.
    const byMember = await app.inject({ method: 'POST', url: '/api/tournaments', headers: h(tM), payload: { name: 'M Cup', buyInCents: 0, capacity: 4, clubId } });
    assert.equal(byMember.statusCode, 403);
    assert.equal(byMember.json().error.code, 'forbidden');

    // The founder can.
    const byFounder = await app.inject({ method: 'POST', url: '/api/tournaments', headers: h(tF), payload: { name: 'F Cup', buyInCents: 0, capacity: 4, clubId } });
    assert.equal(byFounder.statusCode, 201);
    assert.equal(byFounder.json().tournament.clubId, clubId);
  } finally {
    await app.close();
  }
});

test('club tournaments: only members can register; non-members get 403', async () => {
  const { app, tF, tM, tO, clubId } = await build();
  try {
    const created = await app.inject({ method: 'POST', url: '/api/tournaments', headers: h(tF), payload: { name: 'F Cup', buyInCents: 0, capacity: 4, clubId } });
    const id = created.json().tournament.id as string;

    // Outsider (not in the club) is forbidden.
    const byOutsider = await app.inject({ method: 'POST', url: `/api/tournaments/${id}/register`, headers: h(tO) });
    assert.equal(byOutsider.statusCode, 403);
    assert.equal(byOutsider.json().error.code, 'forbidden');

    // A member can register.
    const byMember = await app.inject({ method: 'POST', url: `/api/tournaments/${id}/register`, headers: h(tM) });
    assert.equal(byMember.statusCode, 200);
    assert.ok(byMember.json().tournament.playerIds.length >= 1);
  } finally {
    await app.close();
  }
});

test('global tournament list excludes club tournaments', async () => {
  const { app, tF, tM, clubId } = await build();
  try {
    // A global tournament (no clubId) and a club one.
    await app.inject({ method: 'POST', url: '/api/tournaments', headers: h(tF), payload: { name: 'Global Cup', buyInCents: 0, capacity: 4 } });
    await app.inject({ method: 'POST', url: '/api/tournaments', headers: h(tF), payload: { name: 'Club Cup', buyInCents: 0, capacity: 4, clubId } });

    const list = await app.inject({ method: 'GET', url: '/api/tournaments', headers: h(tM) });
    assert.equal(list.statusCode, 200);
    const names = (list.json().tournaments as Array<{ name: string; clubId: string | null }>).map((t) => t.name);
    assert.ok(names.includes('Global Cup'));
    assert.ok(!names.includes('Club Cup'));
    for (const t of list.json().tournaments as Array<{ clubId: string | null }>) assert.equal(t.clubId, null);
  } finally {
    await app.close();
  }
});

test('GET /api/tournaments/club/:clubId returns club tournaments for a member, 403 for a non-member', async () => {
  const { app, tF, tM, tO, clubId } = await build();
  try {
    await app.inject({ method: 'POST', url: '/api/tournaments', headers: h(tF), payload: { name: 'Club Cup', buyInCents: 0, capacity: 4, clubId } });

    // Member sees it.
    const asMember = await app.inject({ method: 'GET', url: `/api/tournaments/club/${clubId}`, headers: h(tM) });
    assert.equal(asMember.statusCode, 200);
    assert.equal(asMember.json().tournaments.length, 1);
    assert.equal(asMember.json().tournaments[0].name, 'Club Cup');

    // Outsider is forbidden.
    const asOutsider = await app.inject({ method: 'GET', url: `/api/tournaments/club/${clubId}`, headers: h(tO) });
    assert.equal(asOutsider.statusCode, 403);
    assert.equal(asOutsider.json().error.code, 'forbidden');
  } finally {
    await app.close();
  }
});
