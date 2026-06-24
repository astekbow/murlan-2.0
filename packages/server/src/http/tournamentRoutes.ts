// ============================================================================
// MURLAN — Tournament REST routes
// ----------------------------------------------------------------------------
// Players list/view/register (register escrows the buy-in via TournamentService).
// Admin creates, reports a pairing result (advances the bracket; the final pays
// out pool − rake), or cancels (refunds every buy-in). The money math lives in
// TournamentService (unit-tested); these are thin, auth-gated handlers.
// ============================================================================

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';
import type { AdminAuditRepository } from '../auth/adminAudit.ts';
import { checkRealMoneyAccess } from '../compliance/realMoneyGate.ts';
import { requireAuth } from './authRoutes.ts';
import { requirePermission } from './permissions.ts';
import { TournamentService, TournamentError, type Tournament } from '../tournament/tournamentService.ts';
import type { ClubService } from '../social/clubService.ts';
import type { UserRepository } from '../auth/userRepository.ts';
import { InsufficientFundsError } from '../money/walletService.ts';

export interface TournamentRoutesDeps {
  auth: AuthService;
  tournaments: TournamentService;
  // Batch username lookup → the DTO carries a usernames map so the client shows real
  // names (not 6-char id slices) in the bracket/champion. Absent ⇒ usernames omitted.
  users?: UserRepository;
  // Club membership reader → gates club-scoped tournaments (founder-only create,
  // members-only register/list). Absent ⇒ club tournaments are simply unavailable.
  clubs?: ClubService;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService;
  audit?: AdminAuditRepository; // append-only trail for admin create/report/cancel
  // Fired when a tournament fills + starts running, so the gateway can spin up the
  // bracket's live matches (self-running — no admin reporting). No-op if unwired.
  onTournamentRunning?: (tournamentId: string) => void;
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  buyInCents: z.number().int().min(0).max(1_000_000_00),
  capacity: z.union([z.literal(2), z.literal(4), z.literal(8)]),
  // Present ⇒ create a CLUB tournament (founder-only); absent ⇒ a global one.
  clubId: z.string().trim().min(1).optional(),
});

// Admin manual-override report: validated with zod (not a hand-rolled typeof check) so
// NaN/Infinity/negative/float never reach the bracket lookup.
const reportSchema = z.object({
  round: z.number().int().min(0),
  index: z.number().int().min(0),
  winnerId: z.string().min(1),
});

export async function tournamentRoutes(app: FastifyInstance, deps: TournamentRoutesDeps): Promise<void> {
  const { auth, tournaments } = deps;
  const guard = requireAuth(auth);
  // Tournament money actions (report/confirm/cancel pay out or refund a real-money pool)
  // are gated behind the `void_matches` scope (the closest existing money-void scope),
  // not a bare admin check — a scoped support admin must not move tournament money
  // (authz-7). A full admin (empty scopes) passes unchanged.
  const admin = requirePermission(auth, 'void_matches');

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof InsufficientFundsError) return reply.code(402).send({ error: { code: 'insufficient_funds', message: 'Fonde të pamjaftueshme.' } });
    if (e instanceof TournamentError) return reply.code(e.code === 'not_found' ? 404 : 409).send({ error: { code: e.code, message: e.message } });
    throw e;
  };

  // Collect every distinct user id referenced by a tournament (players + every bracket
  // slot + the champion/pending champion) so we can resolve them to usernames in ONE
  // batched query — never N+1. nulls (empty bracket slots) are skipped.
  const idsOf = (t: Tournament): string[] => {
    const ids = new Set<string>(t.playerIds);
    for (const m of t.bracket) { if (m.aUserId) ids.add(m.aUserId); if (m.bUserId) ids.add(m.bUserId); if (m.winnerId) ids.add(m.winnerId); }
    if (t.winnerId) ids.add(t.winnerId);
    if (t.pendingWinnerId) ids.add(t.pendingWinnerId);
    return [...ids];
  };

  // Attach a usernames map { userId → username } to the tournament DTO so the client
  // renders real names. ONE batched lookup across the whole list (collect all ids first).
  // If the user repo is unwired or the lookup fails, the DTO ships without usernames and
  // the client falls back to its id-slice (graceful — bots/unknown ids never block).
  const decorate = async (ts: Tournament[]): Promise<Array<Tournament & { usernames: Record<string, string> }>> => {
    const all = new Set<string>();
    for (const t of ts) for (const id of idsOf(t)) all.add(id);
    let byId = new Map<string, string>();
    if (deps.users && all.size > 0) {
      const users = await deps.users.findManyByIds([...all]).catch(() => []);
      byId = new Map(users.map((u) => [u.id, u.username]));
    }
    return ts.map((t) => {
      const usernames: Record<string, string> = {};
      for (const id of idsOf(t)) { const name = byId.get(id); if (name) usernames[id] = name; }
      return { ...t, usernames };
    });
  };
  const decorateOne = async (t: Tournament) => (await decorate([t]))[0]!;

  app.get('/api/tournaments', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    return reply.send({ tournaments: await decorate(await tournaments.list()) });
  });

  app.get('/api/tournaments/:id', async (req, reply) => {
    if (!(await guard(req, reply))) return;
    const t = await tournaments.get((req.params as { id: string }).id);
    if (!t) return reply.code(404).send({ error: { code: 'not_found', message: 'Turneu nuk u gjet.' } });
    return reply.send({ tournament: await decorateOne(t) });
  });

  app.post('/api/tournaments/:id/register', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const id = (req.params as { id: string }).id;
    const t = await tournaments.get(id);
    if (!t) return reply.code(404).send({ error: { code: 'not_found', message: 'Turneu nuk u gjet.' } });
    // Club-scoped tournament → only members of THAT club may register.
    if (t.clubId) {
      const m = await deps.clubs?.memberOf(caller.userId);
      if (!m || m.clubId !== t.clubId) return reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm anëtarët e klubit mund të marrin pjesë.' } });
    }
    // A paid buy-in is a real-money wager → enforce the same gates as a staked match
    // (account-state + compliance + daily loss cap). Free tournaments skip the gate.
    if (t.buyInCents > 0) {
      const gate = await checkRealMoneyAccess({ auth, compliance: deps.compliance, rg: deps.rg }, caller.userId, { checkLoss: true });
      if (!gate.allowed) return reply.code(403).send({ error: { code: gate.code ?? 'blocked', message: gate.message ?? 'Bllokuar.' } });
    }
    try {
      const t2 = await tournaments.register(id, caller.userId);
      // Just filled → the bracket is seeded + 'running'. Kick off the live matches.
      if (t2.status === 'running') deps.onTournamentRunning?.(t2.id);
      return reply.send({ tournament: await decorateOne(t2) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ----- Create (ANY player) -------------------------------------------------
  // Tournaments are self-running (the gateway plays the bracket + advances it), so any
  // authenticated player may open one — the house still takes its rake at the final.
  // The creator is recorded to the audit trail (a real-money pool is about to form).
  app.post('/api/tournaments', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna turneu të pavlefshme.' } });
    // Club tournament → only the FOUNDER of that exact club may open one.
    const clubId = parsed.data.clubId ?? null;
    if (clubId) {
      const m = await deps.clubs?.memberOf(caller.userId);
      if (!m || m.clubId !== clubId || m.role !== 'founder') {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm themeluesi i klubit mund të krijojë turne të klubit.' } });
      }
    }
    try {
      const t = await tournaments.create(parsed.data.name, parsed.data.buyInCents, parsed.data.capacity, clubId);
      await deps.audit?.record({ adminId: caller.userId, action: 'tournament_create', detail: `${t.id} "${t.name}" buyIn=${t.buyInCents} cap=${t.capacity}${clubId ? ` club=${clubId}` : ''} (creator)` }).catch(() => undefined);
      return reply.code(201).send({ tournament: await decorateOne(t) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ----- Club tournaments: list a club's tournaments (members only) ----------
  app.get('/api/tournaments/club/:clubId', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const clubId = (req.params as { clubId: string }).clubId;
    const m = await deps.clubs?.memberOf(caller.userId);
    if (!m || m.clubId !== clubId) return reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm anëtarët e klubit mund t\'i shohin turnetë.' } });
    return reply.send({ tournaments: await decorate(await tournaments.listByClub(clubId)) });
  });

  // ----- Admin: report a pairing winner / cancel(+refund) --------------------
  // Reporting is now done automatically by the gateway as matches finish, but the
  // admin report route stays as a manual override (e.g. to resolve a stuck pairing).

  app.post('/api/tournaments/:id/report', async (req, reply) => {
    const adminCaller = await admin(req, reply);
    if (!adminCaller) return;
    const id = (req.params as { id: string }).id;
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme.' } });
    }
    const b = parsed.data;
    try {
      const t = await tournaments.reportResult(id, b.round, b.index, b.winnerId, adminCaller.userId);
      const paidPrize = t.status === 'finished' ? t.prizePoolCents - Math.floor((t.prizePoolCents * t.rakeBps) / 10000) : null;
      const tail = t.status === 'finished' ? ' CHAMPION' : t.status === 'awaiting_confirmation' ? ' AWAITING-CONFIRM' : '';
      await deps.audit?.record({
        adminId: adminCaller.userId, action: 'tournament_report', targetUserId: b.winnerId,
        amountCents: paidPrize, detail: `${id} r${b.round}#${b.index} winner=${b.winnerId}${tail}`,
      }).catch(() => undefined);
      return reply.send({ tournament: await decorateOne(t) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Dual-control: a SECOND, distinct admin confirms a parked champion → triggers the
  // payout. Only meaningful when dual-control is enabled (TOURNAMENT_DUAL_CONTROL); with
  // it off, a final never enters 'awaiting_confirmation' so this returns not_awaiting.
  app.post('/api/tournaments/:id/confirm', async (req, reply) => {
    const adminCaller = await admin(req, reply);
    if (!adminCaller) return;
    const id = (req.params as { id: string }).id;
    try {
      const t = await tournaments.confirmChampion(id, adminCaller.userId);
      const paidPrize = t.status === 'finished' ? t.prizePoolCents - Math.floor((t.prizePoolCents * t.rakeBps) / 10000) : null;
      await deps.audit?.record({
        adminId: adminCaller.userId, action: 'tournament_confirm', targetUserId: t.winnerId,
        amountCents: paidPrize, detail: `${id} confirmed champion=${t.winnerId} CHAMPION`,
      }).catch(() => undefined);
      return reply.send({ tournament: await decorateOne(t) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/tournaments/:id/cancel', async (req, reply) => {
    const adminCaller = await admin(req, reply);
    if (!adminCaller) return;
    const id = (req.params as { id: string }).id;
    try {
      const t = await tournaments.cancel(id);
      await deps.audit?.record({ adminId: adminCaller.userId, action: 'tournament_cancel', detail: `${id} refunded ${t.playerIds.length} player(s)` }).catch(() => undefined);
      return reply.send({ tournament: await decorateOne(t) });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
