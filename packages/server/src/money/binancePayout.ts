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

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

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
}

export class BinancePayoutProvider implements PayoutProvider {
  readonly name = 'binance-payout';
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: BinancePayoutOptions) {
    this.base = opts.baseUrl ?? API_PROD;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    const map = NETWORKS[this.opts.currency];
    if (!map) return { ok: false, error: `unsupported payout currency: ${this.opts.currency}` };
    try {
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

      // SINGLE-SHOT on purpose — NOT wrapped in fetchWithRetry. A retry on an ambiguous
      // send response (timeout/5xx after Binance may have accepted it) risks a double-pay;
      // the failed-withdrawal RECONCILER (BinanceWithdrawReader) is how a stuck send is
      // detected and the player refunded, not a blind resend.
      const res = await this.fetchFn(`${this.base}/sapi/v1/capital/withdraw/apply`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': this.opts.apiKey, 'content-type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!res.ok) return { ok: false, error: `binance withdraw failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 180)}` };
      const data = await res.json();
      const id = data?.id;
      if (!id) return { ok: false, error: 'binance: no withdrawal id in response' };
      return { ok: true, providerRef: String(id) };
    } catch (err) {
      return { ok: false, error: `binance error: ${String(err)}` };
    }
  }
}
