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
import { depositWebhooks } from '../metrics.ts';
import type { WithdrawalService } from '../money/withdrawals.ts';
import { WithdrawalError } from '../money/withdrawals.ts';
import type { PaymentProvider } from '../money/paymentProvider.ts';
import type { DepositIntentRepository } from '../money/depositIntents.ts';
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';
import { type Notifier, escapeHtml } from '../notify/notifier.ts';
import type { PayoutProvider } from '../money/payoutProvider.ts';
import type { TronDepositVerifier } from '../money/tronDeposit.ts';
import { processWithdrawal } from '../money/autoPayout.ts';

export interface WalletRoutesDeps {
  auth: AuthService;
  wallet: WalletService;
  withdrawals: WithdrawalService;
  provider: PaymentProvider;
  intents: DepositIntentRepository;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService; // responsible-gaming daily deposit cap
  notifier?: Notifier; // ops alert (Telegram) on a new withdrawal request
  payout?: PayoutProvider; // auto crypto payout for small KYC-verified withdrawals
  autoWithdrawMaxCents?: number; // 0/undefined = off; semi-auto fast-track threshold
  tronDeposit?: TronDepositVerifier; // fee-free USDT-TRC20 deposits via on-chain TxID verify
  tronDepositAddress?: string | null; // YOUR receiving address (shown to players)
  webhookSignatureHeader?: string; // default 'x-signature'
  webhookIps?: string[]; // allowed source IPs for the webhook (empty/undefined = allow any)
}

// Deposit/withdraw bounds (cents). Min stops dust intents that cost more to
// process than they're worth; max stops typo/oversized intents from being
// recorded (then becoming un-creditable) AFTER the user has paid. Enforced at
// the route so a bad amount is rejected before any intent/record is created.
const MIN_DEPOSIT_CENTS = 1_500; // $15 — below this most crypto (esp. BTC) is under
// the provider's per-coin minimum, so the checkout would just show "unavailable".
const MAX_DEPOSIT_CENTS = 1_000_000_00; // $1,000,000
const MIN_WITHDRAW_CENTS = 500; // $5
const INTENT_TTL_MS = 72 * 60 * 60 * 1000; // a deposit intent is creditable for 72h

const depositSchema = z.object({ amountCents: z.number().int().min(MIN_DEPOSIT_CENTS).max(MAX_DEPOSIT_CENTS) });
const withdrawSchema = z.object({
  amountCents: z.number().int().min(MIN_WITHDRAW_CENTS).max(MAX_DEPOSIT_CENTS),
  destination: z.string().min(4).max(256),
});

export async function walletRoutes(app: FastifyInstance, deps: WalletRoutesDeps): Promise<void> {
  const { auth, wallet, withdrawals, provider, intents, notifier } = deps;
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
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Depozita minimale është 15 USD.' } });
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
      // Post-process OFF the response path: classify, optionally AUTO-PAY a small
      // KYC-verified withdrawal, then ping the operator on Telegram. The crypto for
      // larger/unverified withdrawals stays manual.
      void (async () => {
        const [u, comp] = await Promise.all([
          auth.getUser(caller.userId).catch(() => null),
          auth.getComplianceProfile(caller.userId).catch(() => null),
        ]);
        await processWithdrawal(
          { id: record.id, amountCents: record.amountCents, destination: record.destination },
          { username: u?.username ?? caller.userId, kycStatus: comp?.kycStatus ?? null },
          { approve: (id) => withdrawals.approve(id), payout: deps.payout ?? null, notifier: notifier ?? null, autoMaxCents: deps.autoWithdrawMaxCents ?? 0 },
        ).catch(() => { /* best-effort: never affects the 201 */ });
      })();
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

  // ----- Fee-free USDT-TRC20 deposits (own address + on-chain TxID verify) ----
  // The player sends to OUR address, then submits the TxID; we verify on-chain and
  // credit. Available only when a TRON deposit address is configured.
  app.get('/api/wallet/deposit/address', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.tronDepositAddress) return reply.send({ address: null });
    return reply.send({ address: deps.tronDepositAddress, currency: 'USDT', network: 'TRC20' });
  });

  const txidSchema = z.object({ txId: z.string().trim().min(60).max(80) });
  app.post('/api/wallet/deposit/txid', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.tronDeposit) return reply.code(501).send({ error: { code: 'unavailable', message: 'Depozitat me TxID nuk disponohen.' } });
    const parsed = txidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'TxID i pavlefshëm.' } });
    const txId = parsed.data.txId;
    const v = await deps.tronDeposit.verify(txId);
    if (!v.ok || v.amountCents == null) return reply.code(400).send({ error: { code: 'not_verified', message: v.error ?? 'Nuk u verifikua.' } });
    // Idempotent on the TxID — a transaction can credit AT MOST once (a replay or a
    // second claimant gets 409, never a double-credit). We must credit a deposit
    // that genuinely arrived on-chain, so no min/cap gate here (the money is real).
    const res = await wallet.credit(caller.userId, v.amountCents, { type: 'deposit', providerRef: `tron:${txId}`, reason: 'Depozitë USDT-TRC20' });
    if (res.idempotent) return reply.code(409).send({ error: { code: 'already_used', message: 'Ky TxID është përdorur tashmë.' } });
    if (notifier) {
      void notifier.notify(
        `💰 <b>Depozitë USDT-TRC20</b>\n` +
        `Lojtari: ${escapeHtml(caller.username ?? caller.userId)}\n` +
        `Shuma: <b>$${(v.amountCents / 100).toFixed(2)}</b>\n` +
        `TxID: <code>${escapeHtml(txId)}</code>`,
      ).catch(() => {});
    }
    return reply.code(201).send({ ok: true, amountCents: v.amountCents, balanceCents: res.balanceCents });
  });

  // Provider webhook: verify source IP (if an allowlist is set) + the signature
  // over the RAW body, then credit.
  const webhookIps = deps.webhookIps ?? [];
  app.post('/api/payments/webhook/:provider', async (req: FastifyRequest, reply: FastifyReply) => {
    // Source-IP allowlist (defense-in-depth on top of the HMAC). Requires Fastify
    // trustProxy so req.ip is the real client behind the reverse proxy.
    if (webhookIps.length > 0 && !webhookIps.includes(req.ip)) {
      depositWebhooks.inc({ outcome: 'rejected' });
      return reply.code(403).send({ error: { code: 'ip_not_allowed', message: 'Burim i palejuar.' } });
    }
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
    if (!intent) { depositWebhooks.inc({ outcome: 'rejected' }); return reply.code(400).send({ error: { code: 'unknown_payment', message: 'Pagesë e panjohur.' } }); }
    if (deposit.amountCents !== intent.amountCents) {
      depositWebhooks.inc({ outcome: 'rejected' });
      return reply.code(400).send({ error: { code: 'amount_mismatch', message: 'Shuma e pagesës nuk përputhet.' } });
    }
    // Reject a stale/replayed intent: a confirmation arriving days after the
    // intent was created is suspect. (credit() remains idempotent on providerRef,
    // so a legitimate retry within the window still credits at most once.)
    if (Date.now() - intent.createdAt > INTENT_TTL_MS) {
      depositWebhooks.inc({ outcome: 'rejected' });
      return reply.code(400).send({ error: { code: 'intent_expired', message: 'Kërkesa e depozitës ka skaduar.' } });
    }

    // Responsible-gaming deposit cap. The pre-check below is an early, cheaper
    // rejection; the AUTHORITATIVE cap is enforced atomically inside credit()
    // (depositCapCents), where it is serialized per user so concurrent webhooks
    // can't both slip past — see walletService.credit().
    let depositCapCents: number | null = null;
    if (deps.rg) {
      const verdict = await deps.rg.checkDeposit(intent.userId, intent.amountCents);
      if (!verdict.allowed) {
        depositWebhooks.inc({ outcome: 'rejected' });
        return reply.code(422).send({ error: { code: verdict.code ?? 'deposit_limit', message: verdict.message ?? 'Kufiri ditor i depozitës u arrit.' } });
      }
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
      depositWebhooks.inc({ outcome: res.idempotent ? 'idempotent' : 'credited' });
      return reply.send({ ok: true, idempotent: res.idempotent, balanceCents: res.balanceCents });
    } catch (e) {
      if (e instanceof DepositCapExceededError) {
        depositWebhooks.inc({ outcome: 'rejected' });
        return reply.code(422).send({ error: { code: 'deposit_limit', message: 'Kufiri ditor i depozitës u arrit.' } });
      }
      throw e;
    }
  });
}
