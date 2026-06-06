// ============================================================================
// MURLAN — NOWPayments PaymentProvider
// ----------------------------------------------------------------------------
// Real crypto deposits via NOWPayments (https://nowpayments.io). createDeposit
// opens a hosted INVOICE (the player picks BTC/USDT/… + pays on NOWPayments'
// page, which handles the address/QR/confirmations). When the payment finishes,
// NOWPayments POSTs a signed IPN to /api/payments/webhook/nowpayments; the wallet
// route credits the user idempotently (bound to the recorded intent — see
// walletRoutes). order_id carries our userId so the payment is attributable.
//
// IPN auth: HMAC-SHA512 over the JSON body with keys sorted recursively, keyed by
// the IPN secret, sent in the `x-nowpayments-sig` header (NOWPayments' scheme).
// ============================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentProvider, DepositRequest, DepositIntent, WebhookDeposit } from './paymentProvider.ts';

const API_PROD = 'https://api.nowpayments.io/v1';
const API_SANDBOX = 'https://api-sandbox.nowpayments.io/v1';
// Credit ONLY when the payment is fully settled. 'partially_paid'/'confirming'/etc.
// must NOT credit (an underpayment stays partially_paid and never reaches finished).
const SETTLED = new Set(['finished']);

/** Recursively sort object keys — NOWPayments signs the KEY-SORTED JSON. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = sortKeys(o[k]); return acc; }, {});
  }
  return v;
}

export class NowPaymentsProvider implements PaymentProvider {
  readonly name = 'nowpayments';
  /** Header NOWPayments signs the IPN with (wired into the webhook route). */
  readonly signatureHeader = 'x-nowpayments-sig';

  private readonly api: string;
  constructor(
    private readonly apiKey: string,
    private readonly ipnSecret: string,
    /** Public app origin, e.g. https://play.example.com — IPN + return URLs are built from it. */
    private readonly appOrigin: string,
    sandbox = false,
  ) {
    this.api = sandbox ? API_SANDBOX : API_PROD;
  }

  async createDeposit(req: DepositRequest): Promise<DepositIntent> {
    const res = await fetch(`${this.api}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        price_amount: req.amountCents / 100,
        price_currency: 'usd',
        order_id: req.userId, // attributes the payment to the user (echoed back in the IPN)
        order_description: 'Murlan deposit',
        ipn_callback_url: `${this.appOrigin}/api/payments/webhook/nowpayments`,
        success_url: `${this.appOrigin}/?deposit=ok`,
        cancel_url: `${this.appOrigin}/`,
        is_fee_paid_by_user: true, // the player covers the network fee, not the house
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`NOWPayments invoice failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { id: string | number; invoice_url: string };
    return {
      providerRef: String(data.id), // invoice id — the IPN echoes this as invoice_id
      payAddress: data.invoice_url, // hosted checkout URL; the client opens it
      amountCents: req.amountCents,
      raw: data as Record<string, unknown>,
    };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookDeposit | null {
    if (!signature) return null;
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody); } catch { return null; }

    const expected = createHmac('sha512', this.ipnSecret).update(JSON.stringify(sortKeys(body))).digest('hex');
    const got = Buffer.from(signature);
    const exp = Buffer.from(expected);
    if (got.length !== exp.length || !timingSafeEqual(got, exp)) return null;

    const orderId = body.order_id;
    const invoiceId = body.invoice_id ?? body.payment_id; // match the createDeposit invoice id
    const priceAmount = Number(body.price_amount);
    if (typeof orderId !== 'string' || invoiceId == null || !Number.isFinite(priceAmount)) return null;

    return {
      providerRef: String(invoiceId),
      userId: orderId,
      amountCents: Math.round(priceAmount * 100),
      currency: typeof body.price_currency === 'string' ? body.price_currency.toUpperCase() : 'USD',
      confirmed: SETTLED.has(String(body.payment_status)),
    };
  }
}
