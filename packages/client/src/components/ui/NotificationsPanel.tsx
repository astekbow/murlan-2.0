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
import { Icon, type IconName } from './Icon.tsx';

const tr = (key: string, vars?: Record<string, string | number>) => translate(key, useLangStore.getState().lang, vars);

const KIND_ICON: Record<NotifKind, IconName> = {
  win: 'trophy',
  invite: 'mail',
  error: 'alert',
  deposit: 'wallet',
  info: 'bell',
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

export function NotificationsPanel({ onClose, top = 64 }: { onClose: () => void; top?: number }) {
  const t = useT();
  const items = useNotifications((s) => s.items);
  // New items prepend + bump `unread`, so the first `unread` rows are the UNREAD ones. Read on close,
  // so while the panel is open we can visually separate what's new from what's already been seen.
  const unread = useNotifications((s) => s.unread);
  // A still-open room invite enables the inline Accept on an 'invite'-action notif.
  const liveInvite = useGameStore((s) => s.invite);
  // Trap Tab inside the open popover and restore focus to the bell on close.
  const panelRef = useFocusTrap<HTMLDivElement>(true);

  // Mark read when the panel CLOSES (not on mount) — the badge stays put while you read, then clears,
  // instead of vanishing the instant you tap the bell. Escape closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      useNotifications.getState().markRead();
    };
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
        className="fixed w-80 max-w-[calc(100vw-1.5rem)] flex flex-col z-[91] panel-solid animate-pop overflow-hidden"
        // Sits just below the top bar (TopBar measures it — lower under a notch / Dynamic Island) and
        // never runs into the home indicator.
        style={{ top, right: 'max(0.75rem, env(safe-area-inset-right))', maxHeight: `calc(100dvh - ${top}px - max(12px, env(safe-area-inset-bottom)))` }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-white/10">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-sm">{t('notifs.title')}</h2>
          {items.length > 0 && <span className="text-xs text-muted">{items.length}</span>}
        </div>

        {/* List */}
        {items.length === 0 ? (
          <div className="text-center px-4 py-10">
            <span className="mx-auto mb-3 grid place-items-center w-12 h-12 rounded-full bg-white/5 text-txt-lo" aria-hidden><Icon name="bell" size={24} /></span>
            <p className="text-sm text-muted">{t('notifs.empty')}</p>
          </div>
        ) : (
          <ul className="flex-1 min-h-0 overflow-y-auto no-scrollbar divide-y divide-white/[.06]">
            {items.map((n, i) => {
              // acceptInvite() joins the SINGLE live-invite slot (overwritten by the newest invite).
              // Older invite rows would join the WRONG room, so only the NEWEST invite gets the actions.
              const showInviteActions = n.action === 'invite' && liveInvite != null && n.id === items.find((x) => x.action === 'invite')?.id;
              const view = targetView(n);
              const routable = view != null;
              const isUnread = i < unread;
              return (
                <li key={n.id} className={`px-4 py-3 ${isUnread ? 'bg-gold/[.06] border-l-2 border-gold' : ''}`}>
                  <div className="flex items-start gap-3">
                    <span className="text-gold-hi mt-0.5 shrink-0" aria-hidden>
                      <Icon name={KIND_ICON[n.kind]} size={18} />
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
          <div className="shrink-0 px-3 py-2.5 border-t border-white/10">
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
    document.getElementById('root') ?? document.body,
  );
}
