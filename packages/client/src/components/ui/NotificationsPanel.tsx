// Notifications dropdown shown under the bell icon. Anchored, right-aligned
// panel with a full-screen click-catcher behind it (mirrors the gear menu in
// TopBar.tsx). Reads the in-memory notifications store; marks everything read on
// mount. Visual only — never touches game/money state.
//
// Notifications are deep-linkable: tapping one routes to the relevant lobby view
// (deposit→wallet, win→leaderboard, friend/club invite→friends/clubs) via
// uiStore.setView. A live room invite (action: 'invite') gets inline Accept/Decline
// that drives the existing gameStore invite flow.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './useFocusTrap.ts';
import { useNotifications } from '../../store/notificationsStore.ts';
import type { Notif, NotifKind } from '../../store/notificationsStore.ts';
import { useUiStore, type LobbyView } from '../../store/uiStore.ts';
import { useGameStore } from '../../store/gameStore.ts';
import { sound } from '../../lib/sound.ts';
import { useT, translate, useLangStore } from '../../lib/i18n.ts';

const tr = (key: string, vars?: Record<string, string | number>) => translate(key, useLangStore.getState().lang, vars);

const KIND_ICON: Record<NotifKind, string> = {
  win: '🏆',
  invite: '📨',
  error: '⚠️',
  deposit: '💰',
  info: '•',
};

// Default landing view by kind when a notification carries no explicit `view` —
// keeps older pushes (and any not yet annotated) tappable to a sensible place.
const KIND_VIEW: Partial<Record<NotifKind, LobbyView>> = {
  win: 'leaderboard',
  deposit: 'wallet',
};

/** The lobby view a notification routes to on tap, or null if it isn't routable. */
function targetView(n: Notif): LobbyView | null {
  return n.view ?? KIND_VIEW[n.kind] ?? null;
}

/** Albanian relative time, e.g. "tani", "5 min", "2 orë", "3 ditë". */
function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return tr('notifs.timeNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return tr('notifs.timeMin', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return tr('notifs.timeHours', { n: hours });
  const days = Math.floor(hours / 24);
  return tr('notifs.timeDays', { n: days });
}

export function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const items = useNotifications((s) => s.items);
  // A still-open room invite enables the inline Accept on an 'invite'-action notif.
  const liveInvite = useGameStore((s) => s.invite);
  // Trap Tab inside the open popover and restore focus to the bell on close.
  const panelRef = useFocusTrap<HTMLDivElement>(true);

  // Opening the panel clears the unread badge; Escape closes it.
  useEffect(() => {
    useNotifications.getState().markRead();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Route to the deep-linked view (if any) and close the panel.
  const openTarget = (n: Notif) => {
    const view = targetView(n);
    if (!view) return;
    sound.play('button');
    useUiStore.getState().setView(view);
    onClose();
  };

  const acceptInvite = () => {
    sound.play('button');
    void useGameStore.getState().acceptInvite();
    onClose();
  };
  const declineInvite = () => {
    useGameStore.getState().dismissInvite();
    // Keep the panel open — the invite line just loses its actions.
  };

  // Portaled to <body> so it floats above all page chrome (avoids being trapped
  // behind the lobby's animated panels). Anchored top-right under the bell icon.
  return createPortal(
    <>
      {/* Full-screen click-catcher. */}
      <div className="fixed inset-0 z-[90]" onClick={onClose} aria-hidden />

      <div
        ref={panelRef}
        role="dialog"
        aria-label={t('notifs.ariaLabel')}
        className="fixed right-3 top-16 w-80 max-w-[calc(100vw-1.5rem)] z-[91] panel-solid animate-pop overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-sm">{t('notifs.title')}</h2>
          {items.length > 0 && <span className="text-xs text-muted">{items.length}</span>}
        </div>

        {/* List */}
        {items.length === 0 ? (
          <div className="text-center px-4 py-10">
            <div className="text-3xl mb-2 opacity-60">🔔</div>
            <p className="text-sm text-muted">{t('notifs.empty')}</p>
          </div>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto no-scrollbar divide-y divide-white/[.06]">
            {items.map((n) => {
              const showInviteActions = n.action === 'invite' && liveInvite != null;
              const view = targetView(n);
              const routable = view != null;
              return (
                <li key={n.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="text-lg leading-none mt-0.5 shrink-0" aria-hidden>
                      {KIND_ICON[n.kind]}
                    </span>
                    {routable ? (
                      <button
                        type="button"
                        onClick={() => openTarget(n)}
                        className="min-w-0 flex-1 text-left group"
                        title={t('notifs.openHint')}
                      >
                        <p className="text-sm text-txt leading-snug break-words group-hover:text-gold-hi transition-colors">{n.text}</p>
                        <p className="text-xs text-muted mt-0.5">{relativeTime(n.ts)} · {t('notifs.tapToOpen')}</p>
                      </button>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-txt leading-snug break-words">{n.text}</p>
                        <p className="text-xs text-muted mt-0.5">{relativeTime(n.ts)}</p>
                      </div>
                    )}
                  </div>
                  {showInviteActions && (
                    <div className="flex gap-2 mt-2 pl-8">
                      <button type="button" className="btn btn-green btn-sm flex-1" onClick={acceptInvite}>
                        {t('notifs.accept')}
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm flex-1" onClick={declineInvite}>
                        {t('notifs.decline')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
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
              {t('notifs.clear')}
            </button>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}
