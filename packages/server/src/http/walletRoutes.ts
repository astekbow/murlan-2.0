// ============================================================================
// MURLAN — Wallet & payments REST routes (Phase 6)
// ----------------------------------------------------------------------------
// Balance, transaction history, deposit-intent creation, withdrawal requests,
// and the provider webhook. The webhook verifies an HMAC signature over the RAW
// body and credits idempotently (a retried webhook never double-credits).
// ============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/authService.ts';
import { requireAuth } from './authRoutes.ts';
import { type WalletService, DepositCapExceededError } from '../money/walletService.ts';
import type { WithdrawalService } from '../money/withdrawals.ts';
import { WithdrawalError } from '../money/withdrawals.ts';
import type { PaymentProvider } from '../money/paymentProvider.ts';
import type { DepositIntentRepository } from '../money/depositIntents.ts';
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';

export interface WalletRoutesDeps {
  auth: AuthService;
  wallet: WalletService;
  withdrawals: WithdrawalService;
  provider: PaymentProvider;
  intents: DepositIntentRepository;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService; // responsible-gaming daily deposit cap
  webhookSignatureHeader?: string; // default 'x-signature'
}

// Deposit/withdraw bounds (cents). Min stops dust intents that cost more to
// process than they're worth; max stops typo/oversized intents from being
// recorded (then becoming un-creditable) AFTER the user has paid. Enforced at
// the route so a bad amount is rejected before any intent/record is created.
const MIN_DEPOSIT_CENTS = 100; // $1
const MAX_DEPOSIT_CENTS = 1_000_000_00; // $1,000,000
const MIN_WITHDRAW_CENTS = 500; // $5
const INTENT_TTL_MS = 72 * 60 * 60 * 1000; // a deposit intent is creditable for 72h

const depositSchema = z.object({ amountCents: z.number().int().min(MIN_DEPOSIT_CENTS).max(MAX_DEPOSIT_CENTS) });
const withdrawSchema = z.object({
  amountCents: z.number().int().min(MIN_WITHDRAW_CENTS).max(MAX_DEPOSIT_CENTS),
  destination: z.string().min(4).max(256),
});

export async function walletRoutes(app: FastifyInstance, deps: WalletRoutesDeps): Promise<void> {
  const { auth, wallet, withdrawals, provider, intents } = deps;
  const guard = requireAuth(auth);
  const sigHeader = (deps.webhookSignatureHeader ?? 'x-signature').toLowerCase();

  app.get('/api/wallet', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return reply.send({ balanceCents: await wallet.getBalance(caller.userId) });
  });

  app.get('/api/wallet/transactions', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return reply.send({ transactions: await wallet.listTransactions(caller.userId) });
  });

  app.post('/api/wallet/deposit', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    // Account-state gate (always on): a frozen account cannot deposit.
    const acct = await auth.checkAccountRealMoney(caller.userId);
    if (!acct.allowed) return reply.code(403).send({ error: { code: acct.code ?? 'account', message: acct.message ?? 'Bllokuar.' } });
    // Compliance gate (spec §13): a real-money deposit requires the enabled checks.
    if (deps.compliance?.enabled) {
      const profile = await auth.getComplianceProfile(caller.userId);
      const verdict = profile ? deps.compliance.checkRealMoney(profile) : { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
      if (!verdict.allowed) return reply.code(403).send({ error: { code: verdict.code ?? 'compliance', message: verdict.message ?? 'Bllokuar.' } });
    }
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Shumë e pavlefshme.' } });
    // Responsible-gaming daily deposit cap (self-imposed) — blocks before any
    // intent is created so the player never pays toward a deposit we'd reject.
    if (deps.rg) {
      const verdict = await deps.rg.checkDeposit(caller.userId, parsed.data.amountCents);
      if (!verdict.allowed) return reply.code(422).send({ error: { code: verdict.code ?? 'deposit_limit', message: verdict.message ?? 'Kufiri ditor u arrit.' } });
    }
    const intent = await provider.createDeposit({ userId: caller.userId, amountCents: parsed.data.amountCents });
    // Record the intent so the webhook credits THIS user, not a body-controlled one.
    await intents.save({ providerRef: intent.providerRef, userId: caller.userId, amountCents: parsed.data.amountCents, currency: 'USD' });
    return reply.send({ providerRef: intent.providerRef, payAddress: intent.payAddress, amountCents: intent.amountCents });
  });

  app.post('/api/wallet/withdraw', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    // Withdrawals are gated for KYC/age/geo, but NOT blocked by self-exclusion:
    // a self-excluded user must still be able to cash out their own balance
    // (trapping their funds is a consumer-protection violation).
    if (deps.compliance?.enabled) {
      const profile = await auth.getComplianceProfile(caller.userId);
      const verdict = profile ? deps.compliance.checkWithdrawal(profile) : { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
      if (!verdict.allowed) return reply.code(403).send({ error: { code: verdict.code ?? 'compliance', message: verdict.message ?? 'Bllokuar.' } });
    }
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme.' } });
    try {
      const record = await withdrawals.request(caller.userId, parsed.data.amountCents, parsed.data.destination);
      return reply.code(201).send({ withdrawal: record });
    } catch (e) {
      if (e instanceof WithdrawalError) {
        return reply.code(e.code === 'insufficient_funds' ? 402 : 400).send({ error: { code: e.code, message: e.message } });
      }
      throw e;
    }
  });

  app.get('/api/wallet/withdrawals', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return reply.send({ withdrawals: await withdrawals.listByUser(caller.userId) });
  });

  // Provider webhook: verify the signature over the RAW body, then credit.
  app.post('/api/payments/webhook/:provider', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const signature = req.headers[sigHeader];
    const sig = Array.isArray(signature) ? signature[0] : signature;

    const deposit = provider.verifyWebhook(rawBody, sig);
    if (!deposit) return reply.code(400).send({ error: { code: 'bad_signature', message: 'Webhook i pavlefshëm.' } });
    if (!deposit.confirmed) return reply.send({ ok: true, status: 'unconfirmed' });

    // Bind the credit to the recorded intent: BOTH the userId and the amount come
    // from the intent we recorded at deposit time, never from the webhook body.
    // Unknown providerRef or a mismatched amount => reject (no minting, even if
    // the signing secret leaked). (A real crypto provider reporting an
    // over/under-payment would be reconciled here against the intent.)
    const intent = await intents.find(deposit.providerRef);
    if (!intent) return reply.code(400).send({ error: { code: 'unknown_payment', message: 'Pagesë e panjohur.' } });
    if (deposit.amountCents !== intent.amountCents) {
      return reply.code(400).send({ error: { code: 'amount_mismatch', message: 'Shuma e pagesës nuk përputhet.' } });
    }
    // Reject a stale/replayed intent: a confirmation arriving days after the
    // intent was created is suspect. (credit() remains idempotent on providerRef,
    // so a legitimate retry within the window still credits at most once.)
    if (Date.now() - intent.createdAt > INTENT_TTL_MS) {
      return reply.code(400).send({ error: { code: 'intent_expired', message: 'Kërkesa e depozitës ka skaduar.' } });
    }

    // Responsible-gaming cap RE-CHECKED at credit time — when the money actually
    // lands. The intent-time pre-check counts only CREDITED deposits, so a flurry
    // of intents could each pass it; this binds the cap on the real balance.
    // (Sequential webhooks are exact; truly-concurrent credits for one user would
    // need the check inside credit()'s transaction — a follow-up tied to a real
    // payment provider + multi-instance, like the documented money-atomicity TODO.)
    let depositCapCents: number | null = null;
    if (deps.rg) {
      const verdict = await deps.rg.checkDeposit(intent.userId, intent.amountCents);
      if (!verdict.allowed) {
        return reply.code(422).send({ error: { code: verdict.code ?? 'deposit_limit', message: verdict.message ?? 'Kufiri ditor i depozitës u arrit.' } });
      }
      // The authoritative cap is enforced ATOMICALLY inside credit() (the pre-check
      // above is just an early, cheaper rejection); pass it through so concurrent
      // credits can't both slip past the cap.
      depositCapCents = (await deps.rg.getLimits(intent.userId)).dailyDepositLimitCents;
    }

    try {
      const res = await wallet.credit(intent.userId, intent.amountCents, {
        type: 'deposit',
        providerRef: deposit.providerRef,
        currency: intent.currency,
        reason: `deposit via ${provider.name}`,
        depositCapCents,
      });
      return reply.send({ ok: true, idempotent: res.idempotent, balanceCents: res.balanceCents });
    } catch (e) {
      if (e instanceof DepositCapExceededError) {
        return reply.code(422).send({ error: { code: 'deposit_limit', message: 'Kufiri ditor i depozitës u arrit.' } });
      }
      throw e;
    }
  });
}
