// ============================================================================
// MURLAN — Web Push provider seam
// ----------------------------------------------------------------------------
// A pluggable outbound Web Push channel, mirroring EmailProvider / PaymentProvider.
// The default ConsolePushProvider just LOGS the would-be notification, so the
// whole subscription + nudge pipeline works end-to-end in dev/tests with no
// external dependency. REAL browser delivery needs self-generated VAPID keys +
// a real provider (e.g. the `web-push` library) injected in production.
// ============================================================================

/** A browser Push subscription (the shape the PushManager hands the client). */
export interface WebPushSubscription {
  endpoint: string;
  p256dh: string; // client public key
  auth: string;   // client auth secret
}

/** A notification payload (kept small — sent through the push service). */
export interface PushPayload {
  title: string;
  body: string;
  url?: string;  // deep link opened on click (defaults to the app root)
  tag?: string;  // coalescing tag so repeat nudges replace, not stack
}

export interface PushProvider {
  readonly name: string;
  /** Deliver one notification to one subscription. Resolves `gone: true` if the
   *  subscription is dead (404/410) so the caller can prune it. */
  send(sub: WebPushSubscription, payload: PushPayload): Promise<{ ok: boolean; gone?: boolean }>;
}

/** Logs the notification instead of sending it. Used until VAPID keys exist. */
export class ConsolePushProvider implements PushProvider {
  readonly name = 'console';
  async send(sub: WebPushSubscription, payload: PushPayload): Promise<{ ok: boolean }> {
    // eslint-disable-next-line no-console
    console.info(`[push:console] → ${sub.endpoint.slice(0, 40)}… "${payload.title}": ${payload.body}`);
    return { ok: true };
  }
}
