// ============================================================================
// MURLAN — Account self-service routes (Phase 7, compliance data)
// ----------------------------------------------------------------------------
// Players supply the data the compliance switches evaluate: date of birth and
// country (for age/geo gating) and can self-exclude (responsible gaming). KYC
// status itself is set by an admin (see adminRoutes).
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth } from './authRoutes.ts';
import type { AdminAuditRepository } from '../auth/adminAudit.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';
import type { PushService } from '../push/pushService.ts';
import { isSafePushEndpoint } from '../push/pushProvider.ts';
import type { WalletService } from '../money/walletService.ts';
import type { WithdrawalRecord } from '../money/withdrawals.ts';

export interface AccountRoutesDeps {
  auth: AuthService;
  audit?: AdminAuditRepository; // records self-service compliance (DOB/country) changes
  rg?: ResponsibleGamingService; // responsible-gaming daily limits (self-service)
  push?: PushService; // Web Push re-engagement subscriptions
  wallet?: WalletService; // for the GDPR data export (the user's own transactions)
  withdrawals?: { listByUser(userId: string): Promise<WithdrawalRecord[]> }; // GDPR export (own withdrawals)
}

const profileSchema = z.object({
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Kod vendi i pavlefshëm.').optional(),
});
const selfExcludeSchema = z.object({ days: z.number().int().positive().max(3650) });
// Browser PushSubscription.toJSON() shape: { endpoint, keys: { p256dh, auth } }.
const pushSubSchema = z.object({
  // SSRF guard (websec/SSRF): the server later POSTs to this endpoint — only https to a public host.
  endpoint: z.string().url().max(2000).refine(isSafePushEndpoint, 'Endpoint njoftimi i pavlefshëm.'),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});
const pushUnsubSchema = z.object({ endpoint: z.string().url().max(2000) });
const limitsSchema = z.object({
  dailyDepositLimitCents: z.number().int().nonnegative().max(1_000_000_00).nullable().optional(),
  dailyLossLimitCents: z.number().int().nonnegative().max(1_000_000_00).nullable().optional(),
});

export async function accountRoutes(app: FastifyInstance, deps: AccountRoutesDeps): Promise<void> {
  const guard = requireAuth(deps.auth);

  app.get('/api/account', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const profile = await deps.auth.getComplianceProfile(caller.userId);
    if (!profile) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    return reply.send({ profile });
  });

  // GDPR Art.15/20: a player downloads ALL the data we hold about them (personal
  // profile + their own financial activity + responsible-gaming settings) as one JSON
  // file. Self-only (the auth guard scopes it to the caller) — never another user.
  app.get('/api/account/export', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const account = await deps.auth.exportPersonalData(caller.userId);
    if (!account) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    // Bounded transaction read (max 500, newest-first) so a self-service export can't
    // load an unbounded per-user ledger into the heap. A larger history export is an
    // operator-assisted process. (Withdrawals are naturally small per user.)
    const [transactions, withdrawals, limits] = await Promise.all([
      deps.wallet ? deps.wallet.listTransactionsPage(caller.userId, { take: 500 }) : Promise.resolve([]),
      deps.withdrawals ? deps.withdrawals.listByUser(caller.userId) : Promise.resolve([]),
      deps.rg ? deps.rg.getLimits(caller.userId) : Promise.resolve(null),
    ]);
    reply.header('content-disposition', `attachment; filename="murlan-data-${caller.userId}.json"`);
    return reply.send({ exportedAt: Date.now(), account, transactions, withdrawals, limits });
  });

  // GDPR Art.17: a player deletes their OWN account. PII is anonymized + the account
  // closed (login blocked, sessions invalidated); financial records are retained per
  // the AML/legal obligation. Irreversible — the client double-confirms first.
  app.post('/api/account/delete', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const ok = await deps.auth.deleteAccount(caller.userId);
    if (!ok) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    if (deps.audit) {
      await deps.audit.record({ adminId: caller.userId, action: 'account_self_delete', targetUserId: caller.userId, detail: 'GDPR self-deletion (PII anonymized; financial records retained)' }).catch(() => undefined);
    }
    return reply.send({ ok: true });
  });

  app.post('/api/account/profile', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna profili të pavlefshme.' } });

    // The KYC immutability gate is enforced in the SERVICE layer (updateSelfProfile),
    // not here — so it can't be bypassed by another caller.
    const res = await deps.auth.updateSelfProfile(caller.userId, { dateOfBirth: parsed.data.dateOfBirth, country: parsed.data.country });
    if (!res.ok) {
      return reply.code(409).send({ error: { code: 'kyc_locked', message: 'Data e lindjes dhe vendi nuk ndryshohen pas verifikimit (KYC).' } });
    }
    // Compliance data is audit-relevant: record self-service DOB/country changes
    // with the same rigor as admin changes (regulators expect a full trail).
    if (res.changed && deps.audit) {
      await deps.audit.record({ adminId: caller.userId, action: 'profile_self_update', targetUserId: caller.userId, detail: 'DOB/country (self-service)' }).catch(() => undefined);
    }
    return reply.send({ user: res.user });
  });

  app.post('/api/account/self-exclude', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = selfExcludeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Numër ditësh i pavlefshëm.' } });
    const requested = Date.now() + parsed.data.days * 24 * 60 * 60 * 1000;
    // Self-exclusion can only be EXTENDED, never shortened or cancelled.
    const current = (await deps.auth.getComplianceProfile(caller.userId))?.selfExcludedUntil ?? 0;
    const until = Math.max(current, requested);
    await deps.auth.updateCompliance(caller.userId, { selfExcludedUntil: until });
    return reply.send({ ok: true, selfExcludedUntil: until });
  });

  // ----- Web Push subscriptions (re-engagement) ------------------------------
  if (deps.push) {
    const push = deps.push;
    app.post('/api/account/push-subscription', async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      const parsed = pushSubSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Abonim njoftimesh i pavlefshëm.' } });
      await push.subscribe(caller.userId, { endpoint: parsed.data.endpoint, p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth });
      return reply.send({ ok: true });
    });

    app.delete('/api/account/push-subscription', async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      const parsed = pushUnsubSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Endpoint i pavlefshëm.' } });
      await push.unsubscribe(parsed.data.endpoint, caller.userId);
      return reply.send({ ok: true });
    });
  }

  // ----- Responsible-gaming daily limits (self-service) ----------------------
  if (deps.rg) {
    const rg = deps.rg;
    app.get('/api/account/limits', async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      return reply.send({ limits: await rg.getLimits(caller.userId) });
    });

    // Limits + today's usage — drives the wallet "approaching your daily limit" banner.
    // Per-route cap (dos-1): this aggregates the user's ledger; a tight per-IP limit
    // stops a poll-flood from hammering it. (Applies only when the global plugin is on.)
    app.get('/api/account/rg-status', { config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req: any) => req.ip } } }, async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      return reply.send({ status: await rg.getStatus(caller.userId) });
    });

    app.post('/api/account/limits', async (req, reply) => {
      const caller = await guard(req, reply);
      if (!caller) return;
      const parsed = limitsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Kufij të pavlefshëm.' } });
      const limits = await rg.setLimits(caller.userId, parsed.data);
      return reply.send({ limits });
    });
  }
}
