// ============================================================================
// MURLAN — NOWPayments Mass Payout provider (automatic crypto withdrawals)
// ----------------------------------------------------------------------------
// Sends crypto to a player's address via the NOWPayments Mass Payout API. The
// flow (3 calls): auth (email+password → JWT) → create payout (x-api-key + Bearer)
// → verify with a 2FA TOTP code. payout() never throws.
//
// ⚠️ SAFETY: this moves REAL money and CANNOT be exercised from CI/dev (it needs a
// funded NOWPayments account with Payouts enabled + 2FA). It is OFF unless the
// payout env (email/password + API key) is set, gated behind a small per-tx cap
// (AUTO_WITHDRAW_MAX_CENTS) and KYC-verified players (see autoPayout.ts), and MUST
// be validated in the NOWPayments SANDBOX with tiny amounts before going live.
//
// Storing the account password + 2FA secret server-side is required for full
// automation and is an account-drain risk if the host is breached — the per-tx
// cap is the blast-radius limiter. Keep large withdrawals MANUAL.
// ============================================================================

import { totp } from './totp.ts';
import type { PayoutProvider, PayoutRequest, PayoutResult } from './payoutProvider.ts';

const API_PROD = 'https://api.nowpayments.io/v1';
const API_SANDBOX = 'https://api-sandbox.nowpayments.io/v1';

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

export interface NowPaymentsPayoutOptions {
  apiKey: string;
  email: string;
  password: string;
  twoFaSecret: string | null; // base32 authenticator secret; null → skip the verify step
  currency: string;           // e.g. 'usdttrc20'
  appOrigin: string;          // for the payout IPN callback URL
  sandbox?: boolean;
  fetchFn?: FetchLike;
  now?: () => number;
}

export class NowPaymentsPayoutProvider implements PayoutProvider {
  readonly name = 'nowpayments-payout';
  private readonly api: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: NowPaymentsPayoutOptions) {
    this.api = opts.sandbox ? API_SANDBOX : API_PROD;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
  }

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    try {
      // 1) Auth → short-lived JWT.
      const auth = await this.fetchFn(`${this.api}/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: this.opts.email, password: this.opts.password }),
      });
      if (!auth.ok) return { ok: false, error: `auth failed (${auth.status})` };
      const token = (await auth.json())?.token as string | undefined;
      if (!token) return { ok: false, error: 'auth: no token' };

      // 2) Create the payout batch. USDT-TRC20 ≈ $1, so amount = USD value.
      const create = await this.fetchFn(`${this.api}/payout`, {
        method: 'POST',
        headers: { 'x-api-key': this.opts.apiKey, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          ipn_callback_url: `${this.opts.appOrigin}/api/payments/webhook/nowpayments-payout`,
          withdrawals: [{ address: req.address, currency: this.opts.currency, amount: req.amountCents / 100 }],
        }),
      });
      if (!create.ok) return { ok: false, error: `create failed (${create.status}): ${(await create.text().catch(() => '')).slice(0, 160)}` };
      const created = await create.json();
      const batchId = String(created?.id ?? created?.batch_withdrawal_id ?? '');
      if (!batchId) return { ok: false, error: 'create: no payout id' };

      // 3) Verify with a 2FA TOTP code (required by NOWPayments for payouts). If
      // no 2FA secret is configured, skip — the batch then awaits manual verify in
      // the NOWPayments dashboard (so it is NOT auto-sent; we report that).
      if (!this.opts.twoFaSecret) {
        return { ok: false, providerRef: batchId, error: 'created but 2FA secret not set — verify manually in NOWPayments' };
      }
      const code = totp(this.opts.twoFaSecret, this.now());
      const verify = await this.fetchFn(`${this.api}/payout/${batchId}/verify`, {
        method: 'POST',
        headers: { 'x-api-key': this.opts.apiKey, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ verification_code: code }),
      });
      if (!verify.ok) return { ok: false, providerRef: batchId, error: `verify failed (${verify.status})` };
      return { ok: true, providerRef: batchId };
    } catch (err) {
      return { ok: false, error: `payout error: ${String(err)}` };
    }
  }
}
