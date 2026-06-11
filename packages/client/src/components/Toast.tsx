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

/** Transient error/success/info banner that auto-dismisses. */
export function Toast({ message, kind = 'error', onDismiss }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(onDismiss, 3500);
    return () => window.clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-40 max-w-[90%]" style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
      <div
        className={`rounded-lg ${KIND_CLASS[kind]} px-4 py-2 text-sm font-medium shadow-lg animate-pop`}
        role={kind === 'error' ? 'alert' : 'status'}
      >
        {message}
      </div>
    </div>
  );
}
