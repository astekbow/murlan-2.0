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
  // money-16: a failure is one of THREE kinds, and the caller MUST treat them differently:
  //   • (neither flag) DEFINITE failure — the send did NOT happen → safe to refund.
  //   • duplicate:true — the provider rejected because THIS withdrawal id was already
  //     submitted (idempotency hit) → the original send stands → mark COMPLETED, NEVER refund.
  //   • ambiguous:true — the outcome is UNKNOWN (network throw / timeout / 5xx) — the funds
  //     MAY have left → NEVER refund; leave completed/flagged + alert; the reconciler decides.
  duplicate?: boolean;
  ambiguous?: boolean;
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
