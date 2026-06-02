// Notifications dropdown shown under the bell icon. Anchored, right-aligned
// panel with a full-screen click-catcher behind it (mirrors the gear menu in
// TopBar.tsx). Reads the in-memory notifications store; marks everything read on
// mount. Visual only — never touches game/money state.

import { useEffect } from 'react';
import { useNotifications } from '../../store/notificationsStore.ts';
import type { NotifKind } from '../../store/notificationsStore.ts';

const KIND_ICON: Record<NotifKind, string> = {
  win: '🏆',
  invite: '📨',
  error: '⚠️',
  deposit: '💰',
  info: '•',
};

/** Albanian relative time, e.g. "tani", "5 min", "2 orë", "3 ditë". */
function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'tani';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} orë`;
  const days = Math.floor(hours / 24);
  return `${days} ditë`;
}

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const items = useNotifications((s) => s.items);

  // Opening the panel clears the unread badge; Escape closes it.
  useEffect(() => {
    useNotifications.getState().markRead();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {/* Full-screen click-catcher (same pattern as the gear menu in TopBar). */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-label="Njoftimet"
        className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] z-40 panel-solid animate-pop overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-sm">NJOFTIMET</h2>
          {items.length > 0 && <span className="text-xs text-muted">{items.length}</span>}
        </div>

        {/* List */}
        {items.length === 0 ? (
          <div className="text-center px-4 py-10">
            <div className="text-3xl mb-2 opacity-60">🔔</div>
            <p className="text-sm text-muted">S'ka njoftime ende.</p>
          </div>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto no-scrollbar divide-y divide-white/[.06]">
            {items.map((n) => (
              <li key={n.id} className="flex items-start gap-3 px-4 py-3">
                <span className="text-lg leading-none mt-0.5 shrink-0" aria-hidden>
                  {KIND_ICON[n.kind]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-txt leading-snug break-words">{n.text}</p>
                  <p className="text-xs text-muted mt-0.5">{relativeTime(n.ts)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Footer */}
        {items.length > 0 && (
          <div className="px-3 py-2.5 border-t border-white/10">
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => useNotifications.getState().clear()}
            >
              Pastro
            </button>
          </div>
        )}
      </div>
    </>
  );
}
