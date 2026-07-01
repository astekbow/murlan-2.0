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

/**
 * REAL browser delivery via the `web-push` library + self-generated VAPID keys.
 * Built lazily (dynamic import) so the dependency only loads when keys are actually
 * configured — dev/tests keep ConsolePushProvider with zero extra runtime cost.
 * The SW (`public/sw.js`) already renders the JSON payload we send here.
 */
export async function createWebPushProvider(opts: {
  publicKey: string;
  privateKey: string;
  subject: string;
}): Promise<PushProvider> {
  const webpush = (await import('web-push')).default;
  webpush.setVapidDetails(opts.subject, opts.publicKey, opts.privateKey);
  return {
    name: 'web-push',
    async send(sub: WebPushSubscription, payload: PushPayload): Promise<{ ok: boolean; gone?: boolean }> {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: payload.title, body: payload.body, url: payload.url ?? '/', tag: payload.tag }),
          { TTL: 60 * 30 }, // 30 min — a stale turn nudge is useless; let it expire rather than pile up
        );
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404 (unknown) / 410 (gone) → the browser dropped the subscription; prune it.
        if (status === 404 || status === 410) return { ok: false, gone: true };
        return { ok: false };
      }
    },
  };
}
