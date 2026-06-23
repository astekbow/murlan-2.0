// ============================================================================
// MURLAN — Binance withdrawal payout provider (automatic crypto withdrawals)
// ----------------------------------------------------------------------------
// Sends crypto from your Binance Spot balance to a player's address via the
// Binance withdrawal API (POST /sapi/v1/capital/withdraw/apply, HMAC-SHA256
// signed). Implements the PayoutProvider interface, so it drops straight into the
// (tested) autoPayout orchestration.
//
// IDEMPOTENCY: we pass our withdrawal id as `withdrawOrderId` — Binance rejects a
// duplicate, so a retry can never double-send.
//
// ⚠️ SAFETY / SETUP (cannot be exercised from CI/dev, and Binance has NO testnet
// for real external withdrawals — the first real test moves real money):
//   • API key needs "Enable Withdrawals" + the server's IP must be WHITELISTED.
//   • To pay arbitrary player addresses, the account's withdrawal ADDRESS whitelist
//     must be OFF (a security downgrade — the small per-tx cap is the limiter).
//   • USDT must sit in the Spot wallet; Binance charges a flat network fee.
// payout() never throws.
// ============================================================================

import { createHmac } from 'node:crypto';
import type { PayoutProvider, PayoutRequest, PayoutResult } from './payoutProvider.ts';
import { fetchWithRetry } from './transientRetry.ts';

const API_PROD = 'https://api.binance.com';

// Prefix on the Binance withdrawOrderId so the reconciler only ever touches OUR
// payouts — if this Binance account is ever shared, another app's withdrawals
// (and sentinel ids like '0'/'null') are ignored, never matched to our records.
export const WITHDRAW_ORDER_PREFIX = 'murlan_';

// Map our app currency code → Binance (coin, network) pair.
const NETWORKS: Record<string, { coin: string; network: string }> = {
  usdttrc20: { coin: 'USDT', network: 'TRX' },
  usdtbep20: { coin: 'USDT', network: 'BSC' },
  btc: { coin: 'BTC', network: 'BTC' },
};

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

// Binance error CODES that mean "this exact withdrawOrderId was already submitted" — i.e.
// a DUPLICATE of an earlier (successful) send, NOT a new failure. Treat as success: the
// original payout stands, so we mark completed and NEVER refund. (Binance has used a few
// codes/messages for this over time; we match on code OR a duplicate-id message.)
const BINANCE_DUPLICATE_CODES = new Set([-9000, -4046, -5021]);
const DUPLICATE_MSG = /duplicat|already exist|already submitt|withdrawOrderId/i;

// How long to wait for the withdraw SEND before aborting. On abort/timeout the outcome is
// AMBIGUOUS (Binance may have accepted it) → never refund; the reconciler resolves it.
const SEND_TIMEOUT_MS = 20_000;

/** One row of Binance withdrawal history, normalized. `withdrawOrderId` is OUR
 *  withdrawal id (set when we created the payout), so we can match it back. */
export interface BinanceWithdrawalStatus {
  withdrawOrderId: string;
  status: number; // Binance: 1=Cancelled, 3=Rejected, 5=Failure (terminal-failed); 6=Completed
  amountCents: number;
}

// Binance withdraw statuses that mean the funds did NOT leave (returned to Spot).
export const BINANCE_WITHDRAW_FAILED = new Set([1, 3, 5]);

/** Reads recent Binance withdrawal history (signed) so a payout that Binance
 *  ACCEPTED but later failed on-chain can be detected (there is no webhook). */
export class BinanceWithdrawReader {
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: { apiKey: string; apiSecret: string; baseUrl?: string; fetchFn?: FetchLike; now?: () => number; retryBaseMs?: number }) {
    this.base = opts.baseUrl ?? API_PROD;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
  }

  async listRecent(sinceMs: number): Promise<BinanceWithdrawalStatus[]> {
    try {
      const params = new URLSearchParams({ coin: 'USDT', startTime: String(Math.max(0, Math.floor(sinceMs))), timestamp: String(this.now()), recvWindow: '10000' });
      const signature = createHmac('sha256', this.opts.apiSecret).update(params.toString()).digest('hex');
      params.append('signature', signature);
      // Reconciler READ → transient-retry (429/5xx/throw) so a Binance blip can't make the
      // failed-withdrawal detector go blind (WEB-7). The payout SEND below is NOT retried.
      const res = await fetchWithRetry(this.fetchFn, `${this.base}/sapi/v1/capital/withdraw/history?${params.toString()}`, { headers: { 'X-MBX-APIKEY': this.opts.apiKey } }, { baseMs: this.opts.retryBaseMs ?? 400 });
      if (!res.ok) return [];
      const rows = await res.json();
      if (!Array.isArray(rows)) return [];
      return rows
        .map((r) => ({ withdrawOrderId: String(r.withdrawOrderId ?? ''), status: Number(r.status), amountCents: Math.round(Number(r.amount) * 100) }))
        // Only OUR prefixed payouts, with a clean status + amount (drops sentinel ids
        // like 'null'/'0' and any NaN amount). Strip the prefix → bare withdrawal id.
        .filter((r) => r.withdrawOrderId.startsWith(WITHDRAW_ORDER_PREFIX) && Number.isInteger(r.status) && Number.isInteger(r.amountCents))
        .map((r) => ({ ...r, withdrawOrderId: r.withdrawOrderId.slice(WITHDRAW_ORDER_PREFIX.length) }));
    } catch {
      return [];
    }
  }
}

export interface BinancePayoutOptions {
  apiKey: string;
  apiSecret: string;
  currency: string; // e.g. 'usdttrc20'
  baseUrl?: string;
  fetchFn?: FetchLike;
  now?: () => number;
  timeoutMs?: number; // SEND abort timeout (default 20s); a timeout is AMBIGUOUS, never a refund
}

/** Inspect a non-2xx Binance withdraw response: a duplicate-order rejection means our
 *  withdrawOrderId was already submitted (the earlier send stands → treat as success).
 *  Returns null when it's not a duplicate (a genuine 4xx failure). */
function classifyBinanceError(status: number, bodyText: string): { duplicate: true } | null {
  let code: number | undefined;
  let msg = '';
  try { const j = JSON.parse(bodyText); code = typeof j?.code === 'number' ? j.code : undefined; msg = String(j?.msg ?? ''); } catch { /* non-JSON body */ }
  if ((code !== undefined && BINANCE_DUPLICATE_CODES.has(code)) || DUPLICATE_MSG.test(msg) || DUPLICATE_MSG.test(bodyText)) {
    return { duplicate: true };
  }
  return null;
}

export class BinancePayoutProvider implements PayoutProvider {
  readonly name = 'binance-payout';
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: BinancePayoutOptions) {
    this.base = opts.baseUrl ?? API_PROD;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    const map = NETWORKS[this.opts.currency];
    if (!map) return { ok: false, error: `unsupported payout currency: ${this.opts.currency}` };
    // Build the signed query. The player receives `amount` minus Binance's flat
    // network fee (USDT-TRC20 ≈ $1, value-stable → amount = USD value).
    const params = new URLSearchParams({
      coin: map.coin,
      network: map.network,
      address: req.address,
      amount: (req.amountCents / 100).toFixed(2),
      withdrawOrderId: WITHDRAW_ORDER_PREFIX + req.withdrawalId, // idempotency + origin tag (Binance dedupes)
      timestamp: String(this.now()),
      recvWindow: '10000',
    });
    const signature = createHmac('sha256', this.opts.apiSecret).update(params.toString()).digest('hex');
    params.append('signature', signature);

    // Abort a hung send so the caller isn't blocked forever — but a timeout is AMBIGUOUS
    // (Binance may already have accepted it), so it must NOT trigger a refund.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // SINGLE-SHOT on purpose — NOT wrapped in fetchWithRetry. A retry on an ambiguous
      // send response (timeout/5xx after Binance may have accepted it) risks a double-pay;
      // the failed-withdrawal RECONCILER (BinanceWithdrawReader) is how a stuck send is
      // detected and the player refunded, not a blind resend.
      const res = await this.fetchFn(`${this.base}/sapi/v1/capital/withdraw/apply`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': this.opts.apiKey, 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal,
      });
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        // A duplicate-order rejection = our id already sent earlier → treat as SUCCESS (no refund).
        if (classifyBinanceError(res.status, bodyText)) {
          return { ok: false, duplicate: true, error: `binance duplicate withdrawOrderId (${res.status}): ${bodyText.slice(0, 180)}` };
        }
        // 5xx / 429 → the request reached Binance but the result is UNKNOWN → AMBIGUOUS (no refund).
        if (res.status >= 500 || res.status === 429) {
          return { ok: false, ambiguous: true, error: `binance withdraw ambiguous (${res.status}): ${bodyText.slice(0, 180)}` };
        }
        // A definite 4xx (bad address / insufficient balance / etc.) → DEFINITE failure → refund.
        return { ok: false, error: `binance withdraw failed (${res.status}): ${bodyText.slice(0, 180)}` };
      }
      // 2xx: Binance sometimes returns an error envelope WITH 200; re-check the body.
      let data: any = null;
      try { data = JSON.parse(bodyText); } catch { /* fall through to the no-id branch */ }
      // A 200 carrying a duplicate-id error code is still a duplicate (success).
      if (data && typeof data.code === 'number' && data.code !== 0 && data.code !== 200) {
        if (classifyBinanceError(200, bodyText)) return { ok: false, duplicate: true, error: `binance duplicate withdrawOrderId: ${bodyText.slice(0, 180)}` };
        return { ok: false, error: `binance withdraw failed (code ${data.code}): ${String(data.msg ?? '').slice(0, 180)}` };
      }
      const id = data?.id;
      if (!id) return { ok: false, error: 'binance: no withdrawal id in response' };
      return { ok: true, providerRef: String(id) };
    } catch (err) {
      // A network throw / abort (timeout) is AMBIGUOUS — the send MAY have reached Binance.
      // NEVER refund on this path; the reconciler reconciles against withdraw history.
      const aborted = (err as { name?: string })?.name === 'AbortError';
      return { ok: false, ambiguous: true, error: aborted ? `binance send timed out after ${this.timeoutMs}ms (ambiguous)` : `binance error (ambiguous): ${String(err)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}
