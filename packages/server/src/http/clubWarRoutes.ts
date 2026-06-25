// ============================================================================
// MURLAN — Club War routes. Founder of club A challenges another club (by tag) to a
// round-robin series (free or buy-in); members of either club register; the gateway
// runs the 1v1 pairings + reports results; the service settles the pool. Membership
// + founder gating live here; the money/scoring math lives in ClubWarService.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/authService.ts';
import type { UserRepository } from '../auth/userRepository.ts';
import type { ClubService } from '../social/clubService.ts';
import { ClubWarService, ClubWarError, type ClubWar } from '../social/clubWarService.ts';
import { requireAuth } from './authRoutes.ts';

export interface ClubWarRoutesDeps {
  auth: AuthService;
  clubWars: ClubWarService;
  clubs: ClubService;
  users: UserRepository;
}

export async function clubWarRoutes(app: FastifyInstance, deps: ClubWarRoutesDeps): Promise<void> {
  const { auth, clubWars, clubs, users } = deps;
  const guard = requireAuth(auth);

  // Attach club tags + a username map so the client renders rosters/pairings without joins.
  async function decorate(war: ClubWar) {
    const a = await clubs.byId(war.clubAId).catch(() => null);
    const b = await clubs.byId(war.clubBId).catch(() => null);
    const ids = [...new Set([...war.rosterA, ...war.rosterB])];
    const us = ids.length ? await users.findManyByIds(ids).catch(() => []) : [];
    const usernames: Record<string, string> = {};
    for (const u of us) usernames[u.id] = u.username;
    return { ...war, clubATag: a?.tag ?? '?', clubBTag: b?.tag ?? '?', clubAName: a?.name ?? null, clubBName: b?.name ?? null, usernames };
  }

  const fail = (reply: import('fastify').FastifyReply, e: unknown) => {
    if (e instanceof ClubWarError) return reply.code(409).send({ error: { code: e.code, message: e.message } });
    throw e;
  };

  // The caller's side in a war ('A'|'B') based on their club membership, or null.
  function sideOf(war: ClubWar, clubId: string | null): 'A' | 'B' | null {
    if (!clubId) return null;
    if (clubId === war.clubAId) return 'A';
    if (clubId === war.clubBId) return 'B';
    return null;
  }

  // List the wars involving the caller's club (newest first).
  app.get('/api/clubwar', async (req, reply) => {
    const caller = await guard(req, reply); if (!caller) return;
    const me = await clubs.memberOf(caller.userId);
    if (!me) return reply.send({ wars: [] });
    const wars = await clubWars.listForClub(me.clubId, 20);
    return reply.send({ wars: await Promise.all(wars.map(decorate)) });
  });

  app.get('/api/clubwar/:id', async (req, reply) => {
    const caller = await guard(req, reply); if (!caller) return;
    const { id } = req.params as { id: string };
    const war = await clubWars.get(id);
    if (!war) return reply.code(404).send({ error: { code: 'not_found', message: 'Lufta nuk u gjet.' } });
    return reply.send({ war: await decorate(war) });
  });

  // Create a war: founder of their club challenges the club with `opponentTag`.
  app.post('/api/clubwar', async (req, reply) => {
    const caller = await guard(req, reply); if (!caller) return;
    const me = await clubs.memberOf(caller.userId);
    if (!me || me.role !== 'founder') return reply.code(403).send({ error: { code: 'not_founder', message: 'Vetëm themeluesi hap luftë klubi.' } });
    const { opponentTag, stakeCents, size } = (req.body ?? {}) as { opponentTag?: string; stakeCents?: number; size?: number };
    const opp = await clubs.byTag(String(opponentTag ?? '').trim());
    if (!opp) return reply.code(404).send({ error: { code: 'no_opponent', message: 'Klubi kundërshtar nuk u gjet.' } });
    if (opp.id === me.clubId) return reply.code(400).send({ error: { code: 'self', message: 'Një klub s’luan kundër vetes.' } });
    try {
      const war = await clubWars.create(me.clubId, opp.id, Math.max(0, Math.floor(Number(stakeCents) || 0)), Math.floor(Number(size) || 1));
      await clubWars.register(war.id, caller.userId, 'A'); // the founder auto-joins side A
      const fresh = await clubWars.get(war.id);
      return reply.send({ war: await decorate(fresh!) });
    } catch (e) { return fail(reply, e); }
  });

  // Register the caller into the war (side derived from their club membership).
  app.post('/api/clubwar/:id/register', async (req, reply) => {
    const caller = await guard(req, reply); if (!caller) return;
    const { id } = req.params as { id: string };
    const war = await clubWars.get(id);
    if (!war) return reply.code(404).send({ error: { code: 'not_found', message: 'Lufta nuk u gjet.' } });
    const me = await clubs.memberOf(caller.userId);
    const side = sideOf(war, me?.clubId ?? null);
    if (!side) return reply.code(403).send({ error: { code: 'not_in_clubs', message: 'S’je në asnjë nga të dy klubet.' } });
    try {
      await clubWars.register(id, caller.userId, side);
      return reply.send({ war: await decorate((await clubWars.get(id))!) });
    } catch (e) { return fail(reply, e); }
  });

  // Founder of the challenger club force-starts / cancels.
  for (const action of ['start', 'cancel'] as const) {
    app.post(`/api/clubwar/:id/${action}`, async (req, reply) => {
      const caller = await guard(req, reply); if (!caller) return;
      const { id } = req.params as { id: string };
      const war = await clubWars.get(id);
      if (!war) return reply.code(404).send({ error: { code: 'not_found', message: 'Lufta nuk u gjet.' } });
      // ONLY the challenger club (A) founder may start/cancel — the comment always intended this,
      // but the check allowed club B too, letting the opponent founder void a war going against them.
      const me = await clubs.memberOf(caller.userId);
      if (!me || me.role !== 'founder' || me.clubId !== war.clubAId) {
        return reply.code(403).send({ error: { code: 'not_founder', message: 'Vetëm themeluesi i klubit sfidues e bën këtë.' } });
      }
      try {
        await (action === 'start' ? clubWars.start(id) : clubWars.cancel(id));
        return reply.send({ war: await decorate((await clubWars.get(id))!) });
      } catch (e) { return fail(reply, e); }
    });
  }
}
