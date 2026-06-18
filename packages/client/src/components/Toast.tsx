import { useEffect } from 'react';
import type { ToastKind } from '../store/gameStore.ts';

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
  useEffect(() => {
    if (!message) return;
    // Errors need time to read; success/info can clear faster.
    const ms = kind === 'error' ? 5000 : 3500;
    const t = window.setTimeout(onDismiss, ms);
    return () => window.clearTimeout(t);
  }, [message, kind, onDismiss]);

  if (!message) return null;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-40 max-w-[90%]" style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
      <button
        type="button"
        onClick={onDismiss}
        className={`flex items-center gap-2 rounded-lg ${KIND_CLASS[kind]} px-4 py-2 text-sm font-medium shadow-lg animate-pop text-left`}
        role={kind === 'error' ? 'alert' : 'status'}
      >
        <span>{message}</span>
        <span aria-hidden className="opacity-70 text-xs leading-none">✕</span>
      </button>
    </div>
  );
}
