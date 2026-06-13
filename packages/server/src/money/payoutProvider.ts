// ============================================================================
// MURLAN — Payout provider (automatic crypto withdrawal send)
// ----------------------------------------------------------------------------
// The app depends only on this interface. A real provider (the Binance withdraw
// API) sends crypto to the player's address; the default NullPayoutProvider
// means "no auto-send configured" → withdrawals stay manual. payout() must NEVER
// throw (return { ok:false } on failure) so the caller can fall back to manual.
// ============================================================================

export interface PayoutRequest {
  withdrawalId: string; // our record id — stable reference for logs/idempotency
  amountCents: number;  // USD cents (provider converts to the payout currency)
  address: string;      // the player's crypto address (must match the payout network)
}

export interface PayoutResult {
  ok: boolean;
  providerRef?: string; // the provider's payout/batch id, on success
  error?: string;       // a short reason, on failure
}

export interface PayoutProvider {
  readonly name: string;
  payout(req: PayoutRequest): Promise<PayoutResult>;
}

/** Default: no auto-send. Every withdrawal stays pending for manual payout. */
export class NullPayoutProvider implements PayoutProvider {
  readonly name = 'null';
  async payout(): Promise<PayoutResult> {
    return { ok: false, error: 'no payout provider configured' };
  }
}
