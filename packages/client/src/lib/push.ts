// ============================================================================
// MURLAN — Web Push subscription (client)
// ----------------------------------------------------------------------------
// Registers this browser for re-engagement push notifications (turn / match /
// friend-request nudges). The VAPID public key is fetched at RUNTIME from the
// server (`/api/push/vapid-public-key`) — images are CI-built, so it can't be a
// build-time env. Without a key the whole feature no-ops.
//
//   • maybeSubscribePush — SILENT: only refreshes an ALREADY-granted subscription
//     (called after login). Never prompts.
//   • enablePush / disablePush — the explicit opt-in, driven by a user gesture
//     (the Settings toggle). enablePush may show the browser permission prompt.
// The SW (`public/sw.js`) renders the pushed payload + handles notification clicks.
// ============================================================================

import { accountApi } from './api.ts';

export type PushEnableResult = 'enabled' | 'denied' | 'unsupported' | 'unconfigured' | 'error';

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window
    && 'Notification' in window;
}

/** Current OS/browser permission for notifications ('default' until asked). */
export function pushPermission(): NotificationPermission {
  return pushSupported() ? Notification.permission : 'denied';
}

// Cache the server key for the session (it never changes at runtime).
let cachedKey: string | null | undefined;
async function vapidKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  try {
    cachedKey = (await accountApi.vapidPublicKey()).key;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

/** base64url VAPID key → Uint8Array, the form every browser reliably accepts for applicationServerKey. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Subscribe (creating one if needed) + register with the server. Assumes permission is granted. */
async function subscribeAndRegister(token: string, key: string): Promise<boolean> {
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  await accountApi.subscribePush(token, { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return true;
}

/**
 * If push is configured AND the user has ALREADY granted permission, ensure a
 * subscription exists and register it. Silent + best-effort — never prompts, never
 * throws into the app. Called after login so a returning opted-in device re-registers.
 */
export async function maybeSubscribePush(token: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const key = await vapidKey();
    if (key) await subscribeAndRegister(token, key);
  } catch {
    /* best-effort: a push-subscription failure must never affect the app */
  }
}

/**
 * Explicit opt-in (from a user gesture): request permission if needed, then
 * subscribe + register. Returns a status the UI can surface.
 */
export async function enablePush(token: string): Promise<PushEnableResult> {
  if (!pushSupported()) return 'unsupported';
  const key = await vapidKey();
  if (!key) return 'unconfigured';
  let perm = Notification.permission;
  if (perm === 'default') {
    try { perm = await Notification.requestPermission(); } catch { return 'error'; }
  }
  if (perm !== 'granted') return 'denied';
  try {
    return (await subscribeAndRegister(token, key)) ? 'enabled' : 'error';
  } catch {
    return 'error';
  }
}

/** Turn push OFF for this device: drop the browser subscription + deregister on the server. */
export async function disablePush(token: string): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const { endpoint } = sub.toJSON();
      await sub.unsubscribe().catch(() => undefined);
      if (endpoint) await accountApi.unsubscribePush(token, endpoint).catch(() => undefined);
    }
  } catch {
    /* best-effort */
  }
}

/** Whether this device currently has an active push subscription (for the toggle's initial state). */
export async function isPushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) != null;
  } catch {
    return false;
  }
}
