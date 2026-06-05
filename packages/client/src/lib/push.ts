// ============================================================================
// MURLAN — Web Push subscription (client)
// ----------------------------------------------------------------------------
// Registers this browser for re-engagement push notifications. GATED on a server
// VAPID public key (VITE_VAPID_PUBLIC_KEY): without it the whole feature no-ops,
// so the app is unaffected until real keys are provisioned. We never PROMPT for
// permission on load (bad UX / browser-discouraged) — `maybeSubscribePush` only
// refreshes an already-granted subscription; an explicit opt-in toggle (which may
// prompt from a user gesture) is a follow-up.
// ============================================================================

import { accountApi } from './api.ts';

const VAPID_PUBLIC_KEY = (import.meta.env as Record<string, string | undefined>).VITE_VAPID_PUBLIC_KEY;

function supported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window
    && 'Notification' in window;
}

/**
 * If push is configured (VAPID key present) AND the user has ALREADY granted
 * notification permission, ensure a subscription exists and register it with the
 * server. Silent + best-effort — never prompts, never throws into the app.
 */
export async function maybeSubscribePush(token: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !supported()) return;
  if (Notification.permission !== 'granted') return; // never prompt without a user gesture
  try {
    const reg = await navigator.serviceWorker.ready;
    // Browsers accept the VAPID public key as a base64url string for applicationServerKey.
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY }));
    const json = sub.toJSON();
    if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
      await accountApi.subscribePush(token, { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
    }
  } catch {
    /* best-effort: a push-subscription failure must never affect the app */
  }
}
