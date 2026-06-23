// ============================================================================
// MURLAN — Admin REST routes (Phase 6, spec §6)
// ----------------------------------------------------------------------------
// Manual balance adjustments (same credit/debit path + ledger as webhooks) and
// withdrawal triage. All routes require the admin role.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAdmin } from './authRoutes.ts';
import { requirePermission, isAdminPermission } from './permissions.ts';
import type { WalletService } from '../money/walletService.ts';
import { InsufficientFundsError, HOUSE_ACCOUNT_ID } from '../money/walletService.ts';
import type { WithdrawalService } from '../money/withdrawals.ts';
import { WithdrawalError } from '../money/withdrawals.ts';
import type { PayoutProvider } from '../money/payoutProvider.ts';
import type { RoomManager } from '../room/roomManager.ts';
import type { MatchesRepository } from '../money/matchesRepository.ts';
import { revenueBreakdown } from '../money/revenueReport.ts';
import { InMemoryAdminAudit, type AdminAuditRepository } from '../auth/adminAudit.ts';
import { checkAdjustGovernance, MAX_ADJUST_CENTS } from '../money/adminAdjustPolicy.ts';
import type { ChatService } from '../chat/chatService.ts';

export interface AdminRoutesDeps {
  auth: AuthService;
  wallet: WalletService;
  withdrawals: WithdrawalService;
  // Auto-send a withdrawal on approve (Binance payout). When null/absent or a
  // NullPayoutProvider, approve just marks it paid (operator sent it manually).
  payout?: PayoutProvider | null;
  // Treasury view (read-only): the Binance free-USDT payout pool + the on-chain USDT
  // balance of a deposit address. Both optional — absent when not configured.
  binanceFreeUsdtCents?: () => Promise<number | null>;
  depositAddressBalanceCents?: (address: string) => Promise<number | null>;
  rooms?: RoomManager; // for the active-matches view
  matches?: MatchesRepository; // for revenue-by-match-type reporting
  audit?: AdminAuditRepository; // append-only admin action log (defaults to in-memory)
  chat?: ChatService; // chat-report triage + global mute
  // Voids an in-progress match (refund all stakes + end the room). Late-bound to
  // the realtime gateway (which owns rooms/sockets/money), absent in HTTP-only tests.
  voidMatch?: (roomId: string, meta: { adminId: string; reason: string }) =>
    Promise<{ ok: true; matchId: string | null; refunded: boolean } | { ok: false; reason: string }>;
  // Force-disconnect a user's live sockets (set on ban/suspend so the live access
  // token can't keep them online). Late-bound to the gateway; absent in HTTP tests.
  kickUser?: (userId: string) => void;
  // The configured owner account (lowercased ADMIN_EMAIL). Protected from demotion so
  // two admins can't gang-demote the owner and lock everyone out of the panel.
  adminEmail?: string | null;
  // admin-6: require a 2nd distinct admin to confirm a manual balance adjustment. OFF by
  // default (the owner is a solo admin; mandatory dual-control would lock them out).
  adjustDualControl?: boolean;
}

// Per-call ceiling enforced at the schema too (a clear 400 on an over-limit number), with
// the same bound + the rolling-24h cap + self-credit block enforced in checkAdjustGovernance.
const adjustSchema = z.object({ deltaCents: z.number().int().min(-MAX_ADJUST_CENTS).max(MAX_ADJUST_CENTS), reason: z.string().min(1).max(280) });
const kycSchema = z.object({ status: z.enum(['none', 'pending', 'verified']) });
const accountStateSchema = z.object({
  state: z.enum(['active', 'frozen', 'suspended', 'banned']),
  reason: z.string().max(280).optional(),
  // Suspension length (suspended only). Bounded at 365 days so a typo'd huge value can't
  // create an effectively-permanent "suspension" (use `banned` for permanent).
  durationMs: z.number().int().positive().max(365 * 24 * 60 * 60 * 1000).optional(),
});
const muteSchema = z.object({
  durationMs: z.number().int().positive().max(30 * 24 * 60 * 60 * 1000).optional(), // default 24h
  reason: z.string().max(280).optional(),
});
const permissionsSchema = z.object({ permissions: z.array(z.string()).max(20) });
const voidSchema = z.object({ reason: z.string().min(1).max(500) });

export async function adminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): Promise<void> {
  const { auth, wallet, withdrawals, rooms, matches } = deps;
  const audit = deps.audit ?? new InMemoryAdminAudit();
  const admin = requireAdmin(auth); // read-only listings: any admin
  // Scoped guards for sensitive actions. A full admin (empty permission list)
  // passes all of these; a scoped admin must hold the matching scope.
  const canAdjust = requirePermission(auth, 'adjust_balance');
  const canAccounts = requirePermission(auth, 'manage_accounts');
  const canAdmins = requirePermission(auth, 'manage_admins');
  const canWithdraw = requirePermission(auth, 'approve_withdrawals');
  const canModerate = requirePermission(auth, 'moderate_chat');
  const canRevenue = requirePermission(auth, 'view_revenue');
  const canVoid = requirePermission(auth, 'void_matches');

  // Owner-protection predicate (admin-1/2/3). Authoritative via auth.isProtectedOwner, with
  // a route-level email fallback so a wiring mismatch (auth without ownerEmail) can't silently
  // disable the guard. Used by /account-state, /kyc, /role, /permissions.
  const ownerEmail = deps.adminEmail ? deps.adminEmail.trim().toLowerCase() : null;
  const isProtectedOwner = async (userId: string): Promise<boolean> => {
    if (await auth.isProtectedOwner(userId)) return true;
    if (!ownerEmail) return false;
    const target = await auth.getUser(userId);
    return !!target && target.email.trim().toLowerCase() === ownerEmail;
  };

  app.get('/api/admin/users', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    // Server-side search + sort + pagination so the panel scales past a few-screens cap
    // (was: send EVERY user, filter/sort/cap on the client). Returns the page + the
    // filtered total so the client can render "showing X of Y" + prev/next.
    const { q, sort, limit, offset } = req.query as { q?: string; sort?: string; limit?: string; offset?: string };
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const needle = (q ?? '').trim().toLowerCase();
    let list = await auth.listUsers();
    if (needle) list = list.filter((u) => u.username.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle));
    list = [...list].sort((a, b) => (sort === 'name' ? a.username.localeCompare(b.username) : b.balanceCents - a.balanceCents));
    return reply.send({ users: list.slice(off, off + lim), total: list.length });
  });

  app.get('/api/admin/audit', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    return reply.send({ actions: await audit.list() });
  });

  app.get('/api/admin/users/:id/transactions', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    return reply.send({ transactions: await wallet.listTransactions((req.params as { id: string }).id) });
  });

  app.get('/api/admin/matches', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    return reply.send({ matches: rooms ? rooms.listActiveMatches() : [] });
  });

  // Void an in-progress match: refund every stake (no winner, no rake) and end the
  // room. Non-destructive (compensating credits) + idempotent in the gateway. The
  // reason is required and audited (compliance). Only acts on an active match.
  app.post('/api/admin/matches/:roomId/void', async (req, reply) => {
    const caller = await canVoid(req, reply);
    if (!caller) return;
    if (!deps.voidMatch) return reply.code(501).send({ error: { code: 'unavailable', message: 'Anulimi i ndeshjeve nuk disponohet.' } });
    const parsed = voidSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Arsyeja e anulimit është e pavlefshme.' } });
    const roomId = (req.params as { roomId: string }).roomId;
    const result = await deps.voidMatch(roomId, { adminId: caller.userId, reason: parsed.data.reason });
    if (!result.ok) {
      // not_found → 404; unavailable (gateway not bound yet, startup) → 503 transient;
      // not_in_match / already_finalized → 409 conflict with the match state.
      const status = result.reason === 'not_found' ? 404 : result.reason === 'unavailable' ? 503 : 409;
      return reply.code(status).send({ error: { code: result.reason, message: 'Ndeshja nuk mund të anulohet (mund të ketë mbaruar tashmë).' } });
    }
    await audit.record({ adminId: caller.userId, action: 'match_void', detail: `${roomId} (match ${result.matchId ?? '—'}, refunded=${result.refunded}): ${parsed.data.reason}` });
    return reply.send({ ok: true, matchId: result.matchId, refunded: result.refunded });
  });

  app.post('/api/admin/users/:id/adjust', async (req, reply) => {
    const caller = await canAdjust(req, reply);
    if (!caller) return;
    const parsed = adjustSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.deltaCents === 0) {
      return reply.code(400).send({ error: { code: 'validation', message: 'Rregullim i pavlefshëm.' } });
    }
    const userId = (req.params as { id: string }).id;
    // Governance (admin-6): per-call ceiling + per-admin rolling-24h cap + no self-credit.
    const gov = await checkAdjustGovernance(audit, caller.userId, userId, parsed.data.deltaCents, { dualControl: deps.adjustDualControl });
    if (!gov.ok) return reply.code(gov.code === 'self_credit' ? 403 : 422).send({ error: { code: gov.code, message: gov.message } });
    try {
      const res = await wallet.adminAdjust(userId, parsed.data.deltaCents, parsed.data.reason);
      await audit.record({ adminId: caller.userId, action: 'balance_adjust', targetUserId: userId, amountCents: parsed.data.deltaCents, detail: parsed.data.reason });
      return reply.send({ balanceCents: res.balanceCents, transaction: res.transaction });
    } catch (e) {
      if (e instanceof InsufficientFundsError) return reply.code(402).send({ error: { code: 'insufficient_funds', message: 'Bilanc i pamjaftueshëm për debitim.' } });
      return reply.code(400).send({ error: { code: 'error', message: 'Rregullimi dështoi.' } });
    }
  });

  app.post('/api/admin/users/:id/kyc', async (req, reply) => {
    const caller = await canAccounts(req, reply);
    if (!caller) return;
    const parsed = kycSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Status KYC i pavlefshëm.' } });
    const userId = (req.params as { id: string }).id;
    // Owner protection (admin-1): a scoped/rogue admin must not be able to neuter the
    // owner's KYC (which, with KYC gating on, could block the owner's own money flows).
    if (await isProtectedOwner(userId)) {
      return reply.code(403).send({ error: { code: 'owner_protected', message: 'KYC e pronarit nuk mund të ndryshohet.' } });
    }
    const user = await auth.updateCompliance(userId, { kycStatus: parsed.data.status });
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    await audit.record({ adminId: caller.userId, action: 'kyc_set', targetUserId: userId, detail: parsed.data.status });
    return reply.send({ user });
  });

  app.post('/api/admin/users/:id/account-state', async (req, reply) => {
    const caller = await canAccounts(req, reply);
    if (!caller) return;
    const parsed = accountStateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Gjendje llogarie e pavlefshme.' } });
    const userId = (req.params as { id: string }).id;
    // Owner protection (admin-1): never freeze/suspend/ban the configured OWNER — a stray
    // or malicious block must not lock the sole operator out of their own platform.
    if (parsed.data.state !== 'active' && (await isProtectedOwner(userId))) {
      return reply.code(403).send({ error: { code: 'owner_protected', message: 'Pronari i platformës nuk mund të bllokohet.' } });
    }
    // A suspension carries an expiry; the other states are open-ended.
    const until = parsed.data.state === 'suspended' && parsed.data.durationMs ? Date.now() + parsed.data.durationMs : null;
    const res = await auth.setAccountState(userId, { state: parsed.data.state, reason: parsed.data.reason ?? null, until });
    if (!res) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    // Ban/suspend already revoked refresh sessions; also kick any LIVE socket so the
    // still-valid access token can't keep them connected (the socket auth gate then
    // refuses reconnects while blocked).
    if (parsed.data.state === 'banned' || parsed.data.state === 'suspended') deps.kickUser?.(userId);
    await audit.record({
      adminId: caller.userId,
      action: 'account_state_set',
      targetUserId: userId,
      detail: `${parsed.data.state}${parsed.data.reason ? ': ' + parsed.data.reason : ''}`,
    });
    return reply.send({ user: res.user, accountState: res.status });
  });

  // Promote / demote an admin. Guards against removing your OWN admin (locking out),
  // demoting the configured OWNER, and a scoped admin minting a FULL admin.
  app.post('/api/admin/users/:id/role', async (req, reply) => {
    const caller = await canAdmins(req, reply);
    if (!caller) return;
    const role = (req.body as { role?: unknown } | undefined)?.role;
    if (role !== 'user' && role !== 'admin') return reply.code(400).send({ error: { code: 'validation', message: 'Rol i pavlefshëm.' } });
    const userId = (req.params as { id: string }).id;
    if (userId === caller.userId && role === 'user') {
      return reply.code(400).send({ error: { code: 'self_demote', message: 'Nuk mund të heqësh vetes rolin e adminit.' } });
    }
    // Anti-escalation (mirrors the /permissions route): a SCOPED admin (non-empty
    // permission list) must NOT be able to promote anyone to `admin`, because a fresh
    // admin defaults to permissions=[] which RBAC treats as a FULL admin — that would
    // let a manage_admins-only admin mint an unrestricted, money-powered admin.
    const callerPerms = (await auth.getUser(caller.userId))?.permissions ?? [];
    if (role === 'admin' && callerPerms.length > 0) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm një admin i plotë mund të caktojë rolin e adminit.' } });
    }
    // Protect the configured OWNER (ADMIN_EMAIL) from demotion: two admins must not be
    // able to gang-demote the owner and lock everyone out of the panel.
    if (role === 'user' && (await isProtectedOwner(userId))) {
      return reply.code(403).send({ error: { code: 'owner_protected', message: 'Pronari i platformës nuk mund të zhgradohet.' } });
    }
    // A SCOPED admin must NOT be able to demote a FULL admin (empty list = all powers) —
    // a peer/superior they shouldn't be able to strip (admin-2).
    if (role === 'user' && callerPerms.length > 0) {
      const target = await auth.getUser(userId);
      if (target && target.role === 'admin' && (target.permissions ?? []).length === 0) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm një admin i plotë mund të zhgradojë një admin të plotë.' } });
      }
    }
    const user = await auth.setRole(userId, role);
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    // Admin role changes are security-sensitive: record to the audit trail (already
    // queried elsewhere) and log at warn so they surface in ops/SIEM ingestion.
    await audit.record({ adminId: caller.userId, action: 'role_set', targetUserId: userId, detail: role });
    app.log.warn({ adminId: caller.userId, targetUserId: userId, role }, 'admin role changed');
    return reply.send({ user });
  });

  // Assign granular admin permission scopes (RBAC). Empty list = full admin.
  // Unknown scope strings are dropped; you can't restrict your OWN powers (lockout).
  app.post('/api/admin/users/:id/permissions', async (req, reply) => {
    const caller = await canAdmins(req, reply);
    if (!caller) return;
    const parsed = permissionsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Lejet janë të pavlefshme.' } });
    const userId = (req.params as { id: string }).id;
    if (userId === caller.userId) {
      return reply.code(400).send({ error: { code: 'self_scope', message: 'Nuk mund t’i kufizosh vetes lejet.' } });
    }
    // Owner protection (admin-3): the owner is a FULL admin by definition; their permission
    // list must not be reduced/neutered (boot also re-resets it to []).
    if (await isProtectedOwner(userId)) {
      return reply.code(403).send({ error: { code: 'owner_protected', message: 'Lejet e pronarit nuk mund të ndryshohen.' } });
    }
    const perms = [...new Set(parsed.data.permissions.filter(isAdminPermission))];
    const callerPerms = (await auth.getUser(caller.userId))?.permissions ?? [];
    // A SCOPED admin (non-empty list) must NOT mutate the permissions of a FULL admin
    // (empty list = all powers) — that's a peer/superior they shouldn't be able to neuter
    // or capture (admin-2). A full admin (empty caller list) can manage anyone.
    if (callerPerms.length > 0) {
      const target = await auth.getUser(userId);
      if (target && target.role === 'admin' && (target.permissions ?? []).length === 0) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm një admin i plotë mund të ndryshojë lejet e një admini të plotë.' } });
      }
    }
    // Anti-escalation: a SCOPED admin (non-empty list) may only grant scopes they
    // themselves hold, and may NOT mint a full admin (empty list = all powers).
    // A full admin (empty list) can grant anything. Without this, a manage_admins-
    // only admin could create unrestricted admins and escalate past their own scope.
    if (callerPerms.length > 0 && (perms.length === 0 || perms.some((p) => !callerPerms.includes(p)))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'Mund të japësh vetëm leje që i ke vetë.' } });
    }
    const user = await auth.setPermissions(userId, perms);
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    await audit.record({ adminId: caller.userId, action: 'permissions_set', targetUserId: userId, detail: perms.length ? perms.join(',') : '(full)' });
    return reply.send({ user });
  });

  // House revenue = the accumulated 10% rake (booked to the synthetic house account).
  app.get('/api/admin/revenue', async (req, reply) => {
    const caller = await canRevenue(req, reply);
    if (!caller) return;
    const txs = await wallet.listTransactions(HOUSE_ACCOUNT_ID);
    const rake = txs.filter((t) => t.type === 'rake');
    const totalRakeCents = rake.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    return reply.send({ totalRakeCents, rakeCount: rake.length });
  });

  // Revenue BREAKDOWN: rake by UTC day + by match type, plus current payout
  // liability (what the house owes players right now = sum of all real balances).
  // Read-only aggregation over the ledger; no money is moved.
  app.get('/api/admin/revenue/breakdown', async (req, reply) => {
    const caller = await canRevenue(req, reply);
    if (!caller) return;
    const txs = await wallet.listTransactions(HOUSE_ACCOUNT_ID);
    const rake = txs.filter((t) => t.type === 'rake');
    // Bulk-load the match type for each rake row (one query) to bucket by type.
    const ids = [...new Set(rake.map((t) => t.matchId).filter((x): x is string => !!x))];
    const typeById = new Map<string, string>();
    if (matches && ids.length) for (const m of await matches.findManyByIds(ids)) typeById.set(m.id, m.type);
    const report = revenueBreakdown(
      rake.map((t) => ({ amountCents: t.amountCents, matchId: t.matchId, createdAt: t.createdAt })),
      typeById,
    );
    // Outstanding obligation to PLAYERS = sum of every player's balance. Exclude
    // admin/staff accounts — their balance isn't money owed to players.
    const users = await auth.listUsers();
    const payoutLiabilityCents = users.filter((u) => u.role === 'user').reduce((sum, u) => sum + u.balanceCents, 0);
    return reply.send({ ...report, payoutLiabilityCents });
  });

  // Treasury snapshot: where ALL the money is, in one read-only view — the house's
  // rake earnings, what we owe players, the on-chain USDT sitting in deposit addresses
  // (awaiting a sweep), the Binance payout pool, and pending withdrawals. Lets the
  // operator see coverage + decide when to sweep deposits / top up Binance.
  app.get('/api/admin/treasury', async (req, reply) => {
    const caller = await canRevenue(req, reply);
    if (!caller) return;
    const [houseRakeCents, users, pending] = await Promise.all([
      wallet.getBalance(HOUSE_ACCOUNT_ID),
      auth.listUsers(),
      withdrawals.listPending(),
    ]);
    const playerLiabilitiesCents = users.filter((u) => u.role === 'user').reduce((s, u) => s + u.balanceCents, 0);
    const pendingWithdrawalsCents = pending.reduce((s, w) => s + w.amountCents, 0);

    // Binance free USDT (the payout pool) — null if Binance isn't configured.
    const binanceFreeCents = deps.binanceFreeUsdtCents ? await deps.binanceFreeUsdtCents().catch(() => null) : null;

    // On-chain USDT across deposit addresses (the funds to sweep). Best-effort: a
    // bounded count + small concurrency so a big roster or a TronGrid rate-limit can't
    // hang the request; `depositFundsPartial` flags an incomplete/failed read.
    let depositAddressFundsCents: number | null = null;
    let depositFundsPartial = false;
    const balOf = deps.depositAddressBalanceCents;
    if (balOf) {
      const addrs = await auth.listDepositAddresses().catch(() => [] as string[]);
      const CAP = 250;
      const checked = addrs.slice(0, CAP);
      if (addrs.length > CAP) depositFundsPartial = true;
      let sum = 0;
      let anyFail = false;
      const CONC = 4;
      for (let i = 0; i < checked.length; i += CONC) {
        const results = await Promise.all(checked.slice(i, i + CONC).map((a) => balOf(a).catch(() => null)));
        for (const r of results) { if (r == null) anyFail = true; else sum += r; }
      }
      depositAddressFundsCents = sum;
      if (anyFail) depositFundsPartial = true;
    }

    return reply.send({
      houseRakeCents,
      playerLiabilitiesCents,
      pendingWithdrawalsCents,
      binanceFreeCents,
      depositAddressFundsCents,
      depositFundsPartial,
      // Can the payout pool cover everything pending right now? (null = Binance unknown)
      coverageOk: binanceFreeCents == null ? null : binanceFreeCents >= pendingWithdrawalsCents,
    });
  });

  app.get('/api/admin/withdrawals', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    // Enrich each pending row with WHO is withdrawing + their KYC status, so the
    // operator has context to approve/reject. One listUsers() call, no N+1.
    const [pending, users] = await Promise.all([withdrawals.listPending(), auth.listUsers()]);
    const byId = new Map(users.map((u) => [u.id, u]));
    const enriched = pending.map((w) => {
      const u = byId.get(w.userId);
      return { ...w, username: u?.username ?? null, kycStatus: u?.kycStatus ?? null };
    });
    return reply.send({ withdrawals: enriched });
  });

  // ----- Chat moderation: report queue + global mute -------------------------
  if (deps.chat) {
    const chat = deps.chat;
    app.get('/api/admin/chat-reports', async (req, reply) => {
      if (!(await admin(req, reply))) return;
      return reply.send({ reports: await chat.listReports() });
    });

    app.post('/api/admin/users/:id/mute', async (req, reply) => {
      const caller = await canModerate(req, reply);
      if (!caller) return;
      const parsed = muteSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna heshtjeje të pavlefshme.' } });
      const userId = (req.params as { id: string }).id;
      const durationMs = parsed.data.durationMs ?? 24 * 60 * 60 * 1000;
      await chat.adminMute(userId, durationMs, caller.userId, parsed.data.reason ?? '');
      await audit.record({ adminId: caller.userId, action: 'chat_moderation', targetUserId: userId, detail: `mute ${Math.round(durationMs / 3600000)}h${parsed.data.reason ? ': ' + parsed.data.reason : ''}` });
      return reply.send({ ok: true });
    });

    app.post('/api/admin/users/:id/unmute', async (req, reply) => {
      const caller = await canModerate(req, reply);
      if (!caller) return;
      const userId = (req.params as { id: string }).id;
      await chat.adminUnmute(userId);
      await audit.record({ adminId: caller.userId, action: 'chat_moderation', targetUserId: userId, detail: 'unmute' });
      return reply.send({ ok: true });
    });
  }

  app.post('/api/admin/withdrawals/:id/approve', async (req, reply) => {
    const caller = await canWithdraw(req, reply);
    if (!caller) return;
    const id = (req.params as { id: string }).id;
    return resolveWithdrawal(reply, async () => {
      // Approve now SENDS the payout on-chain (via the configured provider) and only
      // marks 'completed' if the send succeeded; a failed send refunds + stays unpaid.
      const w = await withdrawals.payoutNow(id, deps.payout ?? null, { resolvedByAdminId: caller.userId });
      await audit.record({ adminId: caller.userId, action: 'withdrawal_approve', targetUserId: w.userId, amountCents: w.amountCents, detail: w.providerRef ? `${id} (sent: ${w.providerRef})` : id });
      return w;
    });
  });

  app.post('/api/admin/withdrawals/:id/reject', async (req, reply) => {
    const caller = await canWithdraw(req, reply);
    if (!caller) return;
    const id = (req.params as { id: string }).id;
    // Optional reason — recorded in the audit detail (and shown to support) so a
    // rejection isn't a silent refund.
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    return resolveWithdrawal(reply, async () => {
      const w = await withdrawals.reject(id, { resolvedByAdminId: caller.userId, failureReason: reason || null });
      await audit.record({ adminId: caller.userId, action: 'withdrawal_reject', targetUserId: w.userId, amountCents: w.amountCents, detail: reason ? `${id}: ${reason}` : id });
      return w;
    });
  });
}

async function resolveWithdrawal(reply: import('fastify').FastifyReply, op: () => Promise<unknown>) {
  try {
    return reply.send({ withdrawal: await op() });
  } catch (e) {
    if (e instanceof WithdrawalError) {
      return reply.code(e.code === 'not_found' ? 404 : 409).send({ error: { code: e.code, message: e.message } });
    }
    throw e;
  }
}
