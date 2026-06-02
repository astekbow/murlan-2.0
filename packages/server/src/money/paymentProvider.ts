// ============================================================================
// MURLAN — Payment provider abstraction (Phase 6)
// ----------------------------------------------------------------------------
// Deposits go through a hosted provider behind this interface (NOWPayments /
// Coinbase Commerce / PayPal in production). Phase 6 ships the interface + a
// deterministic MOCK so the full deposit→webhook→credit flow is testable
// without external calls. The webhook signature is HMAC-SHA256-verified; the
// credit is idempotent on the provider's payment id (handled by WalletService).
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
  createDeposit(req: DepositRequest): Promise<DepositIntent>;
  /** Verify the signature and parse the body, or return null if invalid/unconfirmed. */
  verifyWebhook(rawBody: string, signature: string | undefined): WebhookDeposit | null;
}

/**
 * Deterministic provider for tests/local dev. Signs/verifies with HMAC-SHA256
 * over the raw body, exactly like a real hosted provider's webhook contract.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private seq = 0;

  constructor(private readonly secret: string) {}

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

  /** Helper for tests: produce the signature a real provider would send. */
  sign(rawBody: string): string {
    return createHmac('sha256', this.secret).update(rawBody).digest('hex');
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookDeposit | null {
    if (!signature) return null;
    const expected = this.sign(rawBody);
    // Constant-time compare; mismatched lengths can't be equal.
    if (signature.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

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
