// Email-link tokens arrive in the URL FRAGMENT (#resetPassword=… / #verifyEmail=…),
// NOT the query string (auth-4/11): a fragment is never sent to the server, never hits
// nginx access logs, and never leaks via the Referer header to the API.
//
// They're captured ONCE, SYNCHRONOUSLY, at MODULE LOAD — and the fragment is stripped in
// the same tick (before React mounts or any network request runs) so the single-use
// secret never lingers in the address bar / history. The path + any real query string
// (e.g. ?replay=…) are preserved.

function readHash(): string {
  try {
    const h = window.location.hash;
    return h.startsWith('#') ? h.slice(1) : h;
  } catch {
    return '';
  }
}

let pendingResetToken: string | null = null;
let pendingVerifyToken: string | null = null;
(() => {
  const hash = readHash();
  if (!hash) return;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(hash);
  } catch {
    return;
  }
  const reset = params.get('resetPassword');
  const verify = params.get('verifyEmail');
  if (!reset && !verify) return;
  pendingResetToken = reset;
  pendingVerifyToken = verify;
  // Strip the fragment NOW (synchronous) — keep the path + real query string intact.
  try {
    window.history.replaceState({}, '', window.location.pathname + window.location.search);
  } catch {
    /* non-browser env (SSR/test without jsdom) — nothing to strip */
  }
})();

/** The captured password-reset token (from #resetPassword=…), or null. Stable across reads. */
export function getResetToken(): string | null {
  return pendingResetToken;
}

/** Consume the captured email-verification token exactly once (null thereafter). */
export function takeVerifyToken(): string | null {
  const t = pendingVerifyToken;
  pendingVerifyToken = null;
  return t;
}
