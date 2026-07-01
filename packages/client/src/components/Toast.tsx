import { useEffect } from 'react';
import type { ToastKind } from '../store/gameStore.ts';
import { useT } from '../lib/i18n.ts';

interface ToastProps {
  message: string | null;
  kind?: ToastKind;
  onDismiss: () => void;
}

const KIND_CLASS: Record<ToastKind, string> = {
  error: 'bg-red-600/95',
  success: 'bg-emerald-600/95',
  info: 'bg-slate-700/95',
};

/** Transient error/success/info banner. Errors linger longer (they carry actionable
 *  info like "insufficient balance") and everything is tap-to-dismiss. */
export function Toast({ message, kind = 'error', onDismiss }: ToastProps) {
  const t = useT();
  useEffect(() => {
    if (!message) return;
    // Errors need time to read; success/info can clear faster.
    const ms = kind === 'error' ? 5000 : 3500;
    const t = window.setTimeout(onDismiss, ms);
    return () => window.clearTimeout(t);
  }, [message, kind, onDismiss]);

  return (
    <>
      {/* Persistent live regions (ALWAYS mounted) so each toast is reliably announced — a region that
          mounts/unmounts together with its text is often skipped by VoiceOver/TalkBack. Errors are
          assertive, success/info polite. The visible pill below carries no role (avoids a double-announce). */}
      <div aria-live="assertive" role="alert" className="sr-only">{message && kind === 'error' ? message : ''}</div>
      <div aria-live="polite" role="status" className="sr-only">{message && kind !== 'error' ? message : ''}</div>
      {message && (
        <div className="fixed left-1/2 -translate-x-1/2 z-40 max-w-[90%]" style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('common.close')}
            className={`flex items-center gap-2 rounded-lg ${KIND_CLASS[kind]} px-4 py-2 text-sm font-medium shadow-lg animate-pop text-left`}
          >
            <span>{message}</span>
            <span aria-hidden className="opacity-70 text-xs leading-none">✕</span>
          </button>
        </div>
      )}
    </>
  );
}
