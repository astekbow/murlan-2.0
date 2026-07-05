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
import { type WalletService, DepositCapExceededError, InsufficientFundsError } from '../money/walletService.ts';
import type { FriendsService } from '../social/friendsService.ts';
import { depositWebhooks } from '../metrics.ts';
import type { WithdrawalService } from '../money/withdrawals.ts';
import { WithdrawalError } from '../money/withdrawals.ts';
import type { PaymentProvider } from '../money/paymentProvider.ts';
import type { DepositIntentRepository } from '../money/depositIntents.ts';
import type { ComplianceService } from '../compliance/complianceService.ts';
import type { ResponsibleGamingService } from '../compliance/responsibleGaming.ts';
import { checkRealMoneyAccess } from '../compliance/realMoneyGate.ts';
import { type Notifier, escapeHtml } from '../notify/notifier.ts';
import type { PayoutProvider } from '../money/payoutProvider.ts';
import type { TronDepositVerifier } from '../money/tronDeposit.ts';
import type { TronHdWallet } from '../money/tronHd.ts';
import type { DepositWatchRegistry } from '../money/depositPoller.ts';
import { processWithdrawal } from '../money/autoPayout.ts';
import { isValidTronAddress } from '../money/tronAddress.ts';
import { autoPayouts, tronDeposits } from '../metrics.ts';

export interface WalletRoutesDeps {
  auth: AuthService;
  wallet: WalletService;
  withdrawals: WithdrawalService;
  provider: PaymentProvider;
  intents: DepositIntentRepository;
  compliance?: ComplianceService;
  rg?: ResponsibleGamingService; // responsible-gaming daily deposit cap
  friends?: FriendsService; // player-to-player balance transfers are allowed only between friends
  notifier?: Notifier; // ops alert (Telegram) on a new withdrawal request
  payout?: PayoutProvider; // auto crypto payout for small KYC-verified withdrawals
  payoutLeader?: boolean; // money-2: only the leader instance auto-pays (default true); others → manual
  autoWithdrawMaxCents?: number; // 0/undefined = off; semi-auto fast-track threshold
  dailyAutoWithdrawCapCents?: number; // 0/undefined = off; per-user 24h auto-payout cap
  dailyTransferCapCents?: number; // money-4/6: 0/undefined = UNLIMITED; >0 = per-user 24h transfer-out cap
  globalAutoWithdrawCapCents?: number; // money-7: 0/undefined = off; global 24h auto-payout budget
  destAutoWithdrawCapCents?: number; // money-7: 0/undefined = off; per-destination-address 24h auto-payout cap
  tronDeposit?: TronDepositVerifier; // fee-free USDT-TRC20 deposits via on-chain TxID verify
  depositWallet?: TronHdWallet; // watch-only HD wallet → UNIQUE per-player deposit address (preferred)
  depositWatch?: DepositWatchRegistry; // mark the player as actively depositing → the auto-credit poller watches their address
  tronDepositAddress?: string | null; // legacy SINGLE shared receiving address (used only if no depositWallet)
  hostedDepositEnabled?: boolean; // false → /api/wallet/deposit (hosted checkout) is disabled (mock provider in prod)
  webhookSignatureHeader?: string; // default 'x-signature'
  webhookIps?: string[]; // allowed source IPs for the webhook (empty/undefined = allow any)
}

// Deposit/withdraw bounds (cents). Min stops dust intents that cost more to
// process than they're worth; max stops typo/oversized intents from being
// recorded (then becoming un-creditable) AFTER the user has paid. Enforced at
// the route so a bad amount is rejected before any intent/record is created.
const MIN_DEPOSIT_CENTS = 500; // $5 — safely above Binance's USDT-TRC20 min deposit
// the provider's per-coin minimum, so the checkout would just show "unavailable".
const MAX_DEPOSIT_CENTS = 1_000_000_00; // $1,000,000
const MIN_WITHDRAW_CENTS = 500; // $5
const INTENT_TTL_MS = 72 * 60 * 60 * 1000; // a deposit intent is creditable for 72h

const depositSchema = z.object({ amountCents: z.number().int().min(MIN_DEPOSIT_CENTS).max(MAX_DEPOSIT_CENTS) });
const withdrawSchema = z.object({
  amountCents: z.number().int().min(MIN_WITHDRAW_CENTS).max(MAX_DEPOSIT_CENTS),
  destination: z.string().min(4).max(256),
});
// Player-to-player transfer (friends only). $1 floor stops dust; the deposit max is a sane ceiling.
const MIN_TRANSFER_CENTS = 100; // $1
const transferSchema = z.object({
  toUserId: z.string().min(1).max(64),
  amountCents: z.number().int().min(MIN_TRANSFER_CENTS).max(MAX_DEPOSIT_CENTS),
});

// Per-route limiters for the money endpoints — keyed by the AUTHENTICATED userId
// (so one account can't burn the shared TronGrid verify quota / spam transfers no
// matter how many IPs it rotates through), falling back to req.ip pre-auth. These
// are tighter than the loose global 300/min/IP. Mirrors the auth/club per-route
// limiters. The keyGenerator reads the Bearer subject WITHOUT a DB lookup.
export function userIdFromBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try {
    // Decode WITHOUT verifying: the route guard does the real verification; this only
    // buckets the limiter. A forged sub just buckets the attacker into a made-up key.
    const payload = header.slice(7).split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { sub?: unknown };
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}
const moneyRouteLimit = (max: number, timeWindow: string) => ({
  config: {
    rateLimit: {
      max,
      timeWindow,
      keyGenerator: (req: FastifyRequest) => userIdFromBearer(req) ?? req.ip,
    },
  },
});

// Per-user serialization for withdrawals (red-team #7): runs each user's request + auto-pay
// classify strictly one-at-a-time, so concurrent requests can't all read a stale "prior
// today" and each auto-pay past the daily cap (each queued one sees every earlier row).
// Single-instance only — mirrors WalletService.serializeDeposit; multi-instance needs a DB lock.
const withdrawChain = new Map<string, Promise<unknown>>();
function serializeWithdraw<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = withdrawChain.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run after the previous settles (success or failure)
  const guarded = next.catch(() => undefined); // a rejection must not break the chain
  withdrawChain.set(userId, guarded);
  // correct-3: self-prune once this link settles IF it's still the tail — keeps the map to
  // only users with an in-flight withdrawal instead of one entry per user who ever withdrew.
  void guarded.then(() => {
    if (withdrawChain.get(userId) === guarded) withdrawChain.delete(userId);
  });
  return next;
}

// GLOBAL serialization (audit M4): the per-user chain above is enough for the per-USER daily
// cap, but the global / per-destination 24h budgets are shared across users — two DIFFERENT
// users could both read the same stale "auto-paid today" total before either completes and
// each auto-pay past the GLOBAL ceiling. When a global/dest cap is configured we therefore run
// the whole classify+send critical section on ONE chain so those reads + the auto-pay are
// atomic across users. Single-instance only (the auto-pay calls an external provider, so a DB
// lock can't span it); multi-instance auto-pay would need a DB-backed budget. Default caps off
// → this never engages and withdrawals stay per-user-concurrent.
let globalWithdrawChain: Promise<unknown> = Promise.resolve();
function serializeGlobalWithdraw<T>(fn: () => Promise<T>): Promise<T> {
  const next = globalWithdrawChain.then(fn, fn);
  globalWithdrawChain = next.catch(() => undefined);
  return next;
}

export async function walletRoutes(app: FastifyInstance, deps: WalletRoutesDeps): Promise<void> {
  const { auth, wallet, withdrawals, provider, intents, notifier } = deps;
  const guard = requireAuth(auth);
  const sigHeader = (deps.webhookSignatureHeader ?? 'x-signature').toLowerCase();
  // Tight per-user limits on the money-moving routes (no theft lever, but caps abuse
  // + protects the on-chain verify quota). Only applied when rate-limit is registered.
  const transferRl = moneyRouteLimit(20, '1 minute');
  const withdrawRl = moneyRouteLimit(15, '1 minute');
  const txidRl = moneyRouteLimit(20, '1 minute');

  app.get('/api/wallet', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    return reply.send({ balanceCents: await wallet.getBalance(caller.userId) });
  });

  app.get('/api/wallet/transactions', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    // Bounded, newest-first page (keyset cursor) — never an unbounded per-user scan.
    const q = req.query as { limit?: string; cursor?: string };
    // Clamp at parse (1..500) so a client can't request its whole ledger into the heap — matches the
    // admin/export endpoints and the nextCursor bound below (audit L1).
    const take = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const transactions = await wallet.listTransactionsPage(caller.userId, { take, cursor: q.cursor ?? null });
    // Next-page cursor = the oldest id in this page (null when fewer than a full page).
    const nextCursor = transactions.length >= Math.min(500, Math.max(1, take)) ? transactions[transactions.length - 1]!.id : null;
    return reply.send({ transactions, nextCursor });
  });

  // Player-to-player balance transfer — ONLY between friends. Atomic (wallet.transfer):
  // the sender is debited + the receiver credited in one transaction. Both accounts must be
  // in good standing (a frozen/banned account can't send OR receive).
  // NOTE (owner-acknowledged): no KYC / daily cap / hold here by request — a known AML/fraud
  // surface on a real-money app; revisit with compliance before scaling.
  app.post('/api/wallet/transfer', transferRl, async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid', message: 'Të dhëna të pavlefshme.' } });
    }
    const { toUserId, amountCents } = parsed.data;
    if (toUserId === caller.userId) {
      return reply.code(400).send({ error: { code: 'self', message: "Nuk mund t'i dërgosh lek vetes." } });
    }
    if (!deps.friends || !(await deps.friends.areFriends(caller.userId, toUserId))) {
      return reply.code(403).send({ error: { code: 'not_friends', message: "Mund t'u dërgosh lek vetëm shokëve." } });
    }
    // FULL real-money gate on BOTH parties (money-4/6): account-state AND — when the
    // compliance/RG toggle is ON — KYC/age/geo/SELF-EXCLUSION. This closes the transfer
    // bypass (a self-excluded player could otherwise shuffle funds to a confederate). With
    // the toggle OFF (today's owner setting) this is account-state only — NO behavior change.
    const gateDeps = { auth, compliance: deps.compliance, rg: deps.rg };
    const from = await checkRealMoneyAccess(gateDeps, caller.userId);
    if (!from.allowed) return reply.code(403).send({ error: { code: from.code ?? 'account', message: from.message ?? 'Llogaria jote është e bllokuar.' } });
    const to = await checkRealMoneyAccess(gateDeps, toUserId);
    if (!to.allowed) return reply.code(403).send({ error: { code: 'recipient_blocked', message: 'Marrësi nuk mund të pranojë lek tani.' } });
    // Per-user rolling-24h transfer-OUT cap (AML rail). DEFAULT 0 = UNLIMITED (the owner keeps
    // transfers open); >0 = ledger-enforced (sum of transfer_out in the last 24h + this one).
    const cap = deps.dailyTransferCapCents ?? 0;
    // The cap read + the transfer must run as ONE ordered unit, else N concurrent transfers each read
    // the same stale 24h total and all pass → AML-cap bypass by race (audit 2026-07-05). Serialize on
    // the SAME per-user money-out chain as withdraw. Only engage the chain when the cap is active.
    const doTransfer = async () => {
      if (cap > 0) {
        // FAIL-CLOSED: if we can't read the prior 24h total, REJECT (was `.catch(() => 0)`, which let a
        // transfer through whenever the ledger query hiccuped — an AML-cap bypass).
        let sentToday: number;
        try {
          sentToday = await wallet.transferredOutSince(caller.userId, Date.now() - 24 * 60 * 60 * 1000);
        } catch {
          return reply.code(503).send({ error: { code: 'cap_check_failed', message: 'S’u verifikua dot kufiri i transfertave — provo sërish.' } });
        }
        if (sentToday + amountCents > cap) {
          return reply.code(422).send({ error: { code: 'transfer_cap', message: `Kufiri ditor i transfertave ($${(cap / 100).toLocaleString('en-US')}) u arrit.` } });
        }
      }
      try {
        const res = await wallet.transfer(caller.userId, toUserId, amountCents, { reason: `transfer to ${toUserId}` });
        return reply.send({ balanceCents: res.balanceCents });
      } catch (e) {
        if (e instanceof InsufficientFundsError) {
          return reply.code(400).send({ error: { code: 'insufficient_funds', message: 'Balancë e pamjaftueshme.' } });
        }
        throw e;
      }
    };
    return cap > 0 ? serializeWithdraw(caller.userId, doTransfer) : doTransfer();
  });

  app.post('/api/wallet/deposit', async (req, reply) => {
    // Hosted-checkout deposits run through the MockPaymentProvider stub. In production
    // (without ALLOW_STUB_PROVIDERS) there is no real hosted provider — real deposits
    // use the on-chain TxID flow — so this route is disabled to remove dead/mock money
    // surface. Re-enabled automatically if a real PaymentProvider is ever wired.
    if (deps.hostedDepositEnabled === false) {
      return reply.code(501).send({ error: { code: 'unavailable', message: 'Depozitat me checkout nuk disponohen. Përdor depozitën USDT-TRC20.' } });
    }
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

  app.post('/api/wallet/withdraw', withdrawRl, async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    // Account-state gate (always on): a banned/suspended account must NOT be able to
    // cash out, even within the access-token TTL. checkLogin blocks banned + suspended
    // but ALLOWS `frozen` (a frozen account may still withdraw its OWN funds) — so we
    // deliberately use checkLogin here, NOT checkRealMoney.
    const state = await auth.checkLogin(caller.userId);
    if (!state.allowed) return reply.code(403).send({ error: { code: state.code ?? 'account', message: state.message ?? 'Llogaria jote është e bllokuar.' } });
    // KYC removed (owner decision): no identity verification is required to withdraw.
    // Age/geo (and NOT self-exclusion — funds must stay withdrawable) are still enforced
    // when the compliance toggle is on; KYC_REQUIRED stays off so checkWithdrawal never
    // blocks on KYC. Large/uncapped withdrawals still route to MANUAL operator review.
    if (deps.compliance?.enabled) {
      const profile = await auth.getComplianceProfile(caller.userId);
      const verdict = profile ? deps.compliance.checkWithdrawal(profile) : { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
      if (!verdict.allowed) return reply.code(403).send({ error: { code: verdict.code ?? 'compliance', message: verdict.message ?? 'Bllokuar.' } });
    }
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'Të dhëna të pavlefshme.' } });
    // Payouts are USDT-TRC20 → the destination MUST be a valid TRON address (checksum
    // verified). A typo/wrong-network address would otherwise burn the funds.
    if (!isValidTronAddress(parsed.data.destination.trim())) {
      return reply.code(400).send({ error: { code: 'bad_address', message: 'Adresa duhet të jetë adresë e vlefshme USDT-TRC20 (TRON, fillon me T, 34 karaktere).' } });
    }
    try {
      // RACE-SAFE (#7): the request (atomic debit + row) AND the classify/auto-pay run as ONE
      // ordered unit per user, so concurrent withdrawals can't all read a stale "prior today"
      // and each auto-pay past the daily cap — each queued one counts every earlier row. We
      // AWAIT it (slightly slower response) precisely so the cap decision is correct in order.
      // When a GLOBAL/dest auto-payout cap is configured, serialize ALL users' critical
      // sections on one chain (M4) so the shared-budget read + auto-pay are atomic across
      // users; otherwise the per-user chain (sufficient for the per-user daily cap) keeps
      // different users concurrent.
      const globalCapsOn = (deps.globalAutoWithdrawCapCents ?? 0) > 0 || (deps.destAutoWithdrawCapCents ?? 0) > 0;
      const critical = async () => {
        // Store the TRIMMED address (validation above trims, but the raw value was being
        // persisted — a padded address would then fail the payout-time TRON re-validation).
        const rec = await withdrawals.request(caller.userId, parsed.data.amountCents, parsed.data.destination.trim());
        // The user's total non-rejected withdrawals in the last 24h — the per-user daily auto-payout
        // cap input. Use the UNBOUNDED DB aggregate, NOT the 100-row display list: reusing listByUser
        // here silently dropped in-window rows past 100, so >100 small withdrawals/24h bypassed the
        // cap and auto-drained the balance (audit money, 2026-07-03). sumUserSince INCLUDES `rec`
        // (just created), so subtract it — the cap adds amountCents back itself.
        const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
        const [u, comp, priorTotalCents] = await Promise.all([
          auth.getUser(caller.userId).catch(() => null),
          auth.getComplianceProfile(caller.userId).catch(() => null),
          withdrawals.sumUserSince(caller.userId, dayAgo).catch(() => null),
        ]);
        // FAIL CLOSED (money-1): a read error → +Infinity so the daily cap is treated as exceeded
        // → the withdrawal routes to MANUAL review rather than silently auto-paying past the cap.
        const priorTodayCents = priorTotalCents === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, priorTotalCents - rec.amountCents);
        // money-7 signals — computed only when auto-pay COULD fire (a real provider + threshold
        // on), so they add no reads on the manual-only path:
        //   • globalTodayCents  — ALL users' auto-paid in 24h (global budget),
        //   • destTodayCents    — auto-paid to THIS destination in 24h (per-destination cap),
        //   • recentTransferInCents — P2P received in 24h (received funds → manual review).
        // money-2: only the payout LEADER auto-pays. On a non-leader replica (PAYOUT_LEADER=false)
        // isLeader is false → no auto-send + no cap reads → every withdrawal routes to MANUAL, so two
        // replicas can't each auto-pay past the in-process shared budget.
        const isLeader = deps.payoutLeader !== false;
        const autoCouldFire = isLeader && (deps.autoWithdrawMaxCents ?? 0) > 0 && !!deps.payout && deps.payout.name !== 'null';
        // FAIL CLOSED (money-1): each cap read defaults to +Infinity on error, so a transient DB
        // blip makes the cap look EXCEEDED → the auto-drain guard forces MANUAL review instead of
        // treating the budget as fully available (the old `() => 0` fail-OPEN). Only reached when
        // the matching cap is configured (>0); an off cap resolves to 0 and never hits the catch.
        const [globalTodayCents, destTodayCents, recentTransferInCents] = autoCouldFire
          ? await Promise.all([
              (deps.globalAutoWithdrawCapCents ?? 0) > 0 ? withdrawals.autoPaidSince(dayAgo).catch(() => Number.POSITIVE_INFINITY) : Promise.resolve(0),
              (deps.destAutoWithdrawCapCents ?? 0) > 0 ? withdrawals.autoPaidSince(dayAgo, rec.destination).catch(() => Number.POSITIVE_INFINITY) : Promise.resolve(0),
              wallet.transferredInSince(caller.userId, dayAgo).catch(() => Number.POSITIVE_INFINITY),
            ])
          : [0, 0, 0];
        // Auto-send only when a REAL payout provider is configured. The send is CLAIM-FIRST
        // + refund-safe inside withdrawals.autoPayout (money-16): it claims the row before
        // sending so a concurrent reject can't double-pay, and refunds ONLY on a definite
        // failure (duplicate/ambiguous are left paid). No provider → sendAuto is null → the
        // row stays pending for the operator (Approve sends it on-chain via payoutNow).
        const realPayout = isLeader && deps.payout && deps.payout.name !== 'null' ? deps.payout : null;
        const outcome = await processWithdrawal(
          { id: rec.id, amountCents: rec.amountCents, destination: rec.destination },
          { username: u?.username ?? caller.userId, kycStatus: comp?.kycStatus ?? null, priorTodayCents, globalTodayCents, destTodayCents, recentTransferInCents },
          { sendAuto: realPayout ? (id) => withdrawals.autoPayout(id, realPayout) : null, notifier: notifier ?? null, autoMaxCents: deps.autoWithdrawMaxCents ?? 0, dailyAutoCapCents: deps.dailyAutoWithdrawCapCents ?? 0, globalAutoCapCents: deps.globalAutoWithdrawCapCents ?? 0, destAutoCapCents: deps.destAutoWithdrawCapCents ?? 0 },
        ).catch((err) => { app.log.error({ err, withdrawalId: rec.id }, 'auto-payout processing threw'); return null; });
        if (outcome?.autoPaid) {
          autoPayouts.inc({ outcome: 'paid' });
          app.log.info({ withdrawalId: rec.id, amountCents: rec.amountCents }, 'auto-payout sent');
        } else if (outcome?.ambiguous) {
          autoPayouts.inc({ outcome: 'failed' });
          app.log.error({ withdrawalId: rec.id, err: outcome.error }, 'auto-payout AMBIGUOUS → left paid, NOT refunded; verify on-chain');
        } else if (outcome && outcome.tier === 'auto' && outcome.error) {
          autoPayouts.inc({ outcome: 'failed' });
          app.log.warn({ withdrawalId: rec.id, err: outcome.error }, 'auto-payout FAILED → refunded, back to manual');
        }
        return rec;
      };
      const record = globalCapsOn
        ? await serializeGlobalWithdraw(critical)
        : await serializeWithdraw(caller.userId, critical);
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
  // The player's USDT-TRC20 receiving address. With a deposit xpub configured this
  // is a UNIQUE per-player address (assigned on first call), so an on-chain deposit
  // is attributed by which address received it — claim-jacking is impossible. Falls
  // back to the legacy single shared address only if no xpub is set.
  const resolveDepositAddress = async (userId: string): Promise<string | null> => {
    if (deps.depositWallet) {
      const assigned = await deps.auth.assignDepositAddress(userId, (i) => deps.depositWallet!.addressAt(i));
      return assigned?.address ?? null;
    }
    return deps.tronDepositAddress ?? null;
  };

  app.get('/api/wallet/deposit/address', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    const address = await resolveDepositAddress(caller.userId);
    if (!address) return reply.send({ address: null });
    // The player is about to deposit → watch their address so the poller auto-credits
    // the incoming transfer (no TxID needed). Refreshes the watch TTL on each open.
    deps.depositWatch?.markWatching(address, caller.userId);
    return reply.send({ address, currency: 'USDT', network: 'TRC20' });
  });


  const txidSchema = z.object({ txId: z.string().trim().min(60).max(80) });
  app.post('/api/wallet/deposit/txid', txidRl, async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    if (!deps.tronDeposit) return reply.code(501).send({ error: { code: 'unavailable', message: 'Depozitat me TxID nuk disponohen.' } });
    // Resolve THIS player's receiving address. The deposit is verified against it,
    // so a TxID that went to someone else's address can never be claimed here — the
    // address binding (not the TxID alone) is the anti-claim-jacking guarantee.
    const myAddress = await resolveDepositAddress(caller.userId);
    if (!myAddress) return reply.code(501).send({ error: { code: 'unavailable', message: 'Depozitat me TxID nuk disponohen.' } });
    // SAME GATES as a hosted-checkout deposit: an on-chain TxID is not a way around them.
    // A frozen/banned account or a self-excluded / unverified-KYC / geo-blocked player can't
    // credit on-chain funds either — the money stays on-chain until the block is resolved.
    const acct = await auth.checkAccountRealMoney(caller.userId);
    if (!acct.allowed) return reply.code(403).send({ error: { code: acct.code ?? 'account', message: acct.message ?? 'Bllokuar.' } });
    if (deps.compliance?.enabled) {
      const profile = await auth.getComplianceProfile(caller.userId);
      const verdict = profile ? deps.compliance.checkRealMoney(profile) : { allowed: false, code: 'unknown', message: 'Profil i panjohur.' };
      if (!verdict.allowed) return reply.code(403).send({ error: { code: verdict.code ?? 'compliance', message: verdict.message ?? 'Bllokuar.' } });
    }
    const parsed = txidSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'validation', message: 'TxID i pavlefshëm.' } });
    // Normalize to lowercase: TRON tx hashes are lowercase hex on-chain, and the
    // unclaimed-deposit watcher matches the ledger providerRef by lowercased txId.
    const txId = parsed.data.txId.toLowerCase();
    const v = await deps.tronDeposit.verify(txId, myAddress);
    if (!v.ok || v.amountCents == null) { tronDeposits.inc({ outcome: 'rejected' }); return reply.code(400).send({ error: { code: 'not_verified', message: v.error ?? 'Nuk u verifikua.' } }); }
    // Below the stated minimum: don't auto-credit (keeps us safely above Binance's
    // own min deposit). The funds did arrive on-chain → the unclaimed-deposit watcher
    // alerts the operator to credit it manually.
    if (v.amountCents < MIN_DEPOSIT_CENTS) {
      tronDeposits.inc({ outcome: 'rejected' });
      return reply.code(400).send({ error: { code: 'below_min', message: `Depozita minimale është $${(MIN_DEPOSIT_CENTS / 100).toFixed(0)}. Kontakto suportin për shuma më të vogla.` } });
    }
    // Responsible-gaming daily DEPOSIT cap applies to on-chain deposits too — a
    // self-imposed limit shouldn't be bypassed just because funds arrived on-chain.
    // If over cap, DON'T auto-credit: the money is real + already on-chain, so leave it
    // for operator/manual review (the unclaimed-deposit watcher pings). The cap is
    // enforced ATOMICALLY inside credit() via depositCapCents, which EXCLUDES this txId's
    // providerRef from the day's sum — so a replay of an already-credited TxID still
    // resolves to the idempotent 409 below (never a false cap error), even if the cap
    // was lowered meanwhile. (checkDeposit is cap-only, so this single check suffices.)
    const depositCapCents: number | null = deps.rg ? (await deps.rg.getLimits(caller.userId)).dailyDepositLimitCents : null;
    // Idempotent on the TxID — a transaction can credit AT MOST once (a replay or a
    // second claimant gets 409, never a double-credit).
    let res;
    try {
      res = await wallet.credit(caller.userId, v.amountCents, { type: 'deposit', providerRef: `tron:${txId}`, reason: 'Depozitë USDT-TRC20', depositCapCents });
    } catch (e) {
      if (e instanceof DepositCapExceededError) {
        tronDeposits.inc({ outcome: 'rejected' });
        return reply.code(422).send({ error: { code: 'deposit_limit', message: 'Kjo depozitë kalon kufirin ditor. Fondet mbërritën — kontakto suportin për ta kredituar.' } });
      }
      throw e;
    }
    if (res.idempotent) { tronDeposits.inc({ outcome: 'replay' }); return reply.code(409).send({ error: { code: 'already_used', message: 'Ky TxID është përdorur tashmë.' } }); }
    tronDeposits.inc({ outcome: 'credited' });
    app.log.info({ userId: caller.userId, amountCents: v.amountCents, txId }, 'USDT-TRC20 deposit credited');
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
