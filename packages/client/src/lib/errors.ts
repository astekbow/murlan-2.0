// Localized error text. The server returns a stable, language-NEUTRAL `code` plus
// an Albanian `message`. We map code → an `err.<code>` catalog string in the user's
// chosen language, falling back to the server's message (then a generic) when a code
// isn't mapped. This keeps error TEXT (presentation) on the client — where the i18n
// catalog and the selected language already live — while the server stays the single
// source of truth for the CODE. No language has to be threaded through the server.

import { translate, useLangStore, type TVars } from './i18n.ts';

/** Catalog hit for `key`, or null (translate returns the key itself when unmapped). */
function localized(key: string, vars?: TVars): string | null {
  const s = translate(key, useLangStore.getState().lang, vars);
  return s === key ? null : s;
}

/**
 * Message for an HTTP/ApiError `code`. Order: mapped `err.<code>` → the server's
 * message (already specific, e.g. carries an amount) → a generic fallback.
 */
export function errText(code: string | undefined, serverMessage?: string, vars?: TVars): string {
  return (code ? localized('err.' + code, vars) : null) ?? serverMessage ?? localized('err.generic') ?? 'Error';
}

/**
 * Message for a socket ack error `{ code, message }`. Order: mapped `err.<code>` →
 * the server's message → the per-call fallback catalog key (e.g. 'err.createRoomFailed').
 */
export function ackText(err: { code?: string; message?: string } | undefined, fallbackKey: string): string {
  return (err?.code ? localized('err.' + err.code) : null) ?? err?.message ?? localized(fallbackKey) ?? '';
}
