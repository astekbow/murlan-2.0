import { create } from 'zustand';
import type { LobbyView } from './uiStore.ts';

export type NotifKind = 'info' | 'win' | 'invite' | 'error' | 'deposit';

/** Optional deep-link / action attached to a notification (all fields optional so
 *  existing one-arg pushes keep working). */
export interface NotifAction {
  /** Lobby view to open when the notification is tapped (e.g. deposit → wallet). */
  view?: LobbyView;
  /** Inline interaction hint. 'invite' → render Accept/Decline (a live room invite). */
  action?: 'invite';
}

export interface Notif {
  id: number;
  text: string;
  ts: number;
  kind: NotifKind;
  /** Optional view to route to on tap. */
  view?: LobbyView;
  /** Optional inline action (e.g. accept/decline an invite). */
  action?: 'invite';
}

interface NotifStore {
  items: Notif[];
  unread: number;
  push: (text: string, kind?: NotifKind, opts?: NotifAction) => void;
  markRead: () => void;
  clear: () => void;
}

let seq = 0;

export const useNotifications = create<NotifStore>((set) => ({
  items: [],
  unread: 0,
  push(text, kind = 'info', opts) {
    seq += 1;
    const notif: Notif = { id: seq, text, ts: Date.now(), kind, view: opts?.view, action: opts?.action };
    set((s) => ({ items: [notif, ...s.items].slice(0, 40), unread: s.unread + 1 }));
  },
  markRead() {
    set({ unread: 0 });
  },
  clear() {
    set({ items: [], unread: 0 });
  },
}));
