import { create } from 'zustand';

export type NotifKind = 'info' | 'win' | 'invite' | 'error' | 'deposit';
export interface Notif {
  id: number;
  text: string;
  ts: number;
  kind: NotifKind;
}

interface NotifStore {
  items: Notif[];
  unread: number;
  push: (text: string, kind?: NotifKind) => void;
  markRead: () => void;
  clear: () => void;
}

let seq = 0;

export const useNotifications = create<NotifStore>((set) => ({
  items: [],
  unread: 0,
  push(text, kind = 'info') {
    seq += 1;
    set((s) => ({ items: [{ id: seq, text, ts: Date.now(), kind }, ...s.items].slice(0, 40), unread: s.unread + 1 }));
  },
  markRead() {
    set({ unread: 0 });
  },
  clear() {
    set({ items: [], unread: 0 });
  },
}));
