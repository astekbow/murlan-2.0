import { create } from 'zustand';

/** Top-level view selection while in the lobby area (outside a room). */
export type LobbyView = 'lobby' | 'wallet' | 'admin' | 'leaderboard' | 'friends' | 'shop' | 'rewards' | 'support' | 'vip' | 'clubs' | 'tournaments';

interface UiStore {
  view: LobbyView;
  // When set, the provably-fair replay/verifier is shown for this match (overrides
  // the normal routing — works even unauthenticated, for shareable replay links).
  replayMatchId: string | null;
  // When set, a player's profile modal is shown globally (used by /u/<id> deep-links).
  profileUserId: string | null;
  setView: (v: LobbyView) => void;
  openReplay: (matchId: string) => void;
  closeReplay: () => void;
  openProfile: (userId: string) => void;
  closeProfile: () => void;
  reset: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  view: 'lobby',
  replayMatchId: null,
  profileUserId: null,
  setView: (view) => set({ view }),
  openReplay: (replayMatchId) => set({ replayMatchId }),
  closeReplay: () => set({ replayMatchId: null }),
  openProfile: (profileUserId) => set({ profileUserId }),
  closeProfile: () => set({ profileUserId: null }),
  // Reset to the lobby — called on logout so a new user on the same tab never
  // lands on the previous user's wallet/shop/admin view.
  reset: () => set({ view: 'lobby', replayMatchId: null, profileUserId: null }),
}));
