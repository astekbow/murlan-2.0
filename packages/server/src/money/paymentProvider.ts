// ============================================================================
// MURLAN — Payment provider abstraction (Phase 6)
// ----------------------------------------------------------------------------
// A hosted deposit provider can sit behind this interface (a webhook/IPN flow).
// The PRIMARY production deposit rail is the on-chain USDT-TRC20 TxID flow
// (TronDepositVerifier); this interface + a deterministic MOCK keep the
// deposit→webhook→credit flow testable without external calls. The webhook
// signature is HMAC-SHA256-verified; the credit is idempotent on the provider's
// payment id (handled by WalletService).
// ============================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DepositRequest {
  userId: string;
  amountCents: number; // USD cents the user intends to deposit
  currency?: string;   // crypto/PayPal currency label (display only)
}

export interface DepositIntent {
  providerRef: string; // the provider's payment id (idempotency key)
  payAddress: string;  // address / hosted invoice URL the user pays
  amountCents: number;
  raw: Record<string, unknown>;
}

/** A normalised, verified deposit confirmation extracted from a webhook. */
export interface WebhookDeposit {
  providerRef: string;
  userId: string;
  amountCents: number;
  currency: string;
  confirmed: boolean;
}

export interface PaymentProvider {
  readonly name: string;
  /** HTTP header the provider signs its webhook with (default 'x-signature'). */
  readonly signatureHeader?: string;
  createDeposit(req: DepositRequest): Promise<DepositIntent>;
  /** Verify the signature and parse the body, or return null if invalid/unconfirmed. */
  verifyWebhook(rawBody: string, signature: string | undefined): WebhookDeposit | null;
}

/**
 * Deterministic provider for tests/local dev. Signs/verifies with HMAC-SHA256
 * over the raw body, exactly like a real hosted provider's webhook contract.
 */
/** A signed webhook is only accepted within this window of its timestamp (anti-replay). */
export const WEBHOOK_TOLERANCE_SEC = 5 * 60;

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private seq = 0;

  constructor(
    private readonly secret: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async createDeposit(req: DepositRequest): Promise<DepositIntent> {
    this.seq += 1;
    const providerRef = `mock_${this.seq}`;
    return {
      providerRef,
      payAddress: `mock://pay/${providerRef}`,
      amountCents: req.amountCents,
      raw: { providerRef, userId: req.userId, amountCents: req.amountCents },
    };
  }

  /**
   * The signature header a real provider sends, Stripe-style: `t=<unixSeconds>,v1=<hmac>`,
   * where the HMAC is over `${t}.${rawBody}`. Binding the timestamp INTO the signed
   * payload means a captured webhook can't be replayed later (the timestamp can't be
   * altered without breaking the HMAC, and verifyWebhook rejects stale timestamps).
   * `atSec` defaults to now so existing callers/tests get a fresh, valid signature.
   */
  sign(rawBody: string, atSec: number = Math.floor(this.now() / 1000)): string {
    const v1 = createHmac('sha256', this.secret).update(`${atSec}.${rawBody}`).digest('hex');
    return `t=${atSec},v1=${v1}`;
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookDeposit | null {
    if (!signature) return null;
    // Parse `t=...,v1=...` (v1 is hex, so splitting on the first '=' per part is safe).
    let t: number | undefined;
    let v1: string | undefined;
    for (const part of signature.split(',')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const key = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      if (key === 't') t = Number(val);
      else if (key === 'v1') v1 = val;
    }
    if (t === undefined || !Number.isFinite(t) || !v1) return null;

    // Anti-replay: reject a signature whose timestamp is outside the tolerance window.
    const nowSec = Math.floor(this.now() / 1000);
    if (Math.abs(nowSec - t) > WEBHOOK_TOLERANCE_SEC) return null;

    const expected = createHmac('sha256', this.secret).update(`${t}.${rawBody}`).digest('hex');
    if (v1.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) return null;

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (
      typeof body?.providerRef !== 'string' ||
      typeof body?.userId !== 'string' ||
      !Number.isInteger(body?.amountCents) ||
      body.amountCents <= 0
    ) {
      return null;
    }
    return {
      providerRef: body.providerRef,
      userId: body.userId,
      amountCents: body.amountCents,
      currency: typeof body.currency === 'string' ? body.currency : 'USD',
      // Only an explicit "confirmed" status credits; anything else is a no-op ack.
      confirmed: body.status === 'confirmed',
    };
  }
}
