import { useState } from 'react';
import { useT } from '../../lib/i18n.ts';

// First-visit privacy/cookie NOTICE. The app sets only essential auth cookies (no
// tracking/ads), so this is an acknowledgment — not a tracking-consent gate. We remember
// the ack in localStorage (re-prompt only if the policy version changes) and beacon an
// auditable record to /api/consent (best-effort; the server logs who/when/version/IP).
const POLICY_VERSION = '2026-06-22';
const LS_KEY = 'murlan.consent';

function alreadyAcked(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === POLICY_VERSION;
  } catch {
    return false; // private mode / storage blocked → show it (acking is then per-session)
  }
}

export function CookieNotice() {
  const t = useT();
  const [dismissed, setDismissed] = useState(alreadyAcked);
  if (dismissed) return null;

  const accept = () => {
    try { localStorage.setItem(LS_KEY, POLICY_VERSION); } catch { /* storage blocked — still dismiss */ }
    const payload = JSON.stringify({ version: POLICY_VERSION, accepted: true });
    try {
      if (navigator.sendBeacon) navigator.sendBeacon('/api/consent', new Blob([payload], { type: 'application/json' }));
      else void fetch('/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true });
    } catch { /* the ack is recorded locally regardless */ }
    setDismissed(true);
  };

  return (
    <div
      role="dialog"
      aria-label={t('consent.text')}
      className="fixed inset-x-2 bottom-2 z-[60] mx-auto max-w-2xl rounded-xl border border-gold/30 bg-obsidian/95 px-4 py-3 text-sm text-ivory shadow-2xl backdrop-blur"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="leading-snug text-ivory/90">{t('consent.text')}</p>
        <button type="button" onClick={accept} className="btn btn-gold shrink-0 whitespace-nowrap px-4 py-1.5">
          {t('consent.accept')}
        </button>
      </div>
    </div>
  );
}
