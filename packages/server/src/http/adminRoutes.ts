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
import type { WalletService } from '../money/walletService.ts';
import { InsufficientFundsError, HOUSE_ACCOUNT_ID } from '../money/walletService.ts';
import type { WithdrawalService } from '../money/withdrawals.ts';
import { WithdrawalError } from '../money/withdrawals.ts';
import type { RoomManager } from '../room/roomManager.ts';
import { InMemoryAdminAudit, type AdminAuditRepository } from '../auth/adminAudit.ts';
import type { ChatService } from '../chat/chatService.ts';

export interface AdminRoutesDeps {
  auth: AuthService;
  wallet: WalletService;
  withdrawals: WithdrawalService;
  rooms?: RoomManager; // for the active-matches view
  audit?: AdminAuditRepository; // append-only admin action log (defaults to in-memory)
  chat?: ChatService; // chat-report triage + global mute
}

const adjustSchema = z.object({ deltaCents: z.number().int(), reason: z.string().min(1) });
const kycSchema = z.object({ status: z.enum(['none', 'pending', 'verified']) });
const accountStateSchema = z.object({
  state: z.enum(['active', 'frozen', 'suspended', 'banned']),
  reason: z.string().max(280).optional(),
  durationMs: z.number().int().positive().optional(), // suspension length (suspended only)
});
const muteSchema = z.object({
  durationMs: z.number().int().positive().max(30 * 24 * 60 * 60 * 1000).optional(), // default 24h
  reason: z.string().max(280).optional(),
});

export async function adminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): Promise<void> {
  const { auth, wallet, withdrawals, rooms } = deps;
  const audit = deps.audit ?? new InMemoryAdminAudit();
  const admin = requireAdmin(auth);

  app.get('/api/admin/users', async (req, reply) => {
    if (!(await admin(req, reply))) return;
    return reply.send({ users: await auth.listUsers() });
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

  app.post('/api/admin/users/:id/adjust', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const parsed = adjustSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.deltaCents === 0) {
      return reply.code(400).send({ error: { code: 'validation', message: 'Rregullim i pavlefshëm.' } });
    }
    const userId = (req.params as { id: string }).id;
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
    const caller = await admin(req, reply);
    if (!caller) return;
    const parsed = kycSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Status KYC i pavlefshëm.' } });
    const userId = (req.params as { id: string }).id;
    const user = await auth.updateCompliance(userId, { kycStatus: parsed.data.status });
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    await audit.record({ adminId: caller.userId, action: 'kyc_set', targetUserId: userId, detail: parsed.data.status });
    return reply.send({ user });
  });

  app.post('/api/admin/users/:id/account-state', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const parsed = accountStateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Gjendje llogarie e pavlefshme.' } });
    const userId = (req.params as { id: string }).id;
    // A suspension carries an expiry; the other states are open-ended.
    const until = parsed.data.state === 'suspended' && parsed.data.durationMs ? Date.now() + parsed.data.durationMs : null;
    const res = await auth.setAccountState(userId, { state: parsed.data.state, reason: parsed.data.reason ?? null, until });
    if (!res) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    await audit.record({
      adminId: caller.userId,
      action: 'account_state_set',
      targetUserId: userId,
      detail: `${parsed.data.state}${parsed.data.reason ? ': ' + parsed.data.reason : ''}`,
    });
    return reply.send({ user: res.user, accountState: res.status });
  });

  // Promote / demote an admin. Guards against removing your OWN admin (locking out).
  app.post('/api/admin/users/:id/role', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const role = (req.body as { role?: unknown } | undefined)?.role;
    if (role !== 'user' && role !== 'admin') return reply.code(400).send({ error: { code: 'validation', message: 'Rol i pavlefshëm.' } });
    const userId = (req.params as { id: string }).id;
    if (userId === caller.userId && role === 'user') {
      return reply.code(400).send({ error: { code: 'self_demote', message: 'Nuk mund të heqësh vetes rolin e adminit.' } });
    }
    const user = await auth.setRole(userId, role);
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    await audit.record({ adminId: caller.userId, action: 'role_set', targetUserId: userId, detail: role });
    return reply.send({ user });
  });

  // House revenue = the accumulated 10% rake (booked to the synthetic house account).
  app.get('/api/admin/revenue', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const txs = await wallet.listTransactions(HOUSE_ACCOUNT_ID);
    const rake = txs.filter((t) => t.type === 'rake');
    const totalRakeCents = rake.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    return reply.send({ totalRakeCents, rakeCount: rake.length });
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
      const caller = await admin(req, reply);
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
      const caller = await admin(req, reply);
      if (!caller) return;
      const userId = (req.params as { id: string }).id;
      await chat.adminUnmute(userId);
      await audit.record({ adminId: caller.userId, action: 'chat_moderation', targetUserId: userId, detail: 'unmute' });
      return reply.send({ ok: true });
    });
  }

  app.post('/api/admin/withdrawals/:id/approve', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const id = (req.params as { id: string }).id;
    return resolveWithdrawal(reply, async () => {
      const w = await withdrawals.approve(id);
      await audit.record({ adminId: caller.userId, action: 'withdrawal_approve', targetUserId: w.userId, amountCents: w.amountCents, detail: id });
      return w;
    });
  });

  app.post('/api/admin/withdrawals/:id/reject', async (req, reply) => {
    const caller = await admin(req, reply);
    if (!caller) return;
    const id = (req.params as { id: string }).id;
    // Optional reason — recorded in the audit detail (and shown to support) so a
    // rejection isn't a silent refund.
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    return resolveWithdrawal(reply, async () => {
      const w = await withdrawals.reject(id);
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
