import { create } from 'zustand';

/** Top-level view selection while in the lobby area (outside a room). */
export type LobbyView = 'lobby' | 'wallet' | 'admin' | 'leaderboard' | 'friends' | 'shop' | 'rewards';

interface UiStore {
  view: LobbyView;
  setView: (v: LobbyView) => void;
  reset: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  view: 'lobby',
  setView: (view) => set({ view }),
  // Reset to the lobby — called on logout so a new user on the same tab never
  // lands on the previous user's wallet/shop/admin view.
  reset: () => set({ view: 'lobby' }),
}));
