import { create } from 'zustand';
import { rewardsApi } from '../lib/api.ts';

// The local player's equipped cosmetics, applied to the table (felt theme +
// card-back). Loaded from /rewards on sign-in and updated when the player
// equips something in the shop. Purely cosmetic.
interface CosmeticsStore {
  cardBack: string | null;
  tableFelt: string | null;
  load: (token: string) => Promise<void>;
  setEquipped: (c: { cardBack?: string | null; tableFelt?: string | null }) => void;
}

export const useCosmeticsStore = create<CosmeticsStore>((set) => ({
  cardBack: null,
  tableFelt: null,
  async load(token) {
    try {
      const { status } = await rewardsApi.status(token);
      set({ cardBack: status.equipped.cardBack, tableFelt: status.equipped.tableFelt });
    } catch {
      /* rewards may be disabled or offline — keep defaults */
    }
  },
  setEquipped(c) {
    set((s) => ({ cardBack: c.cardBack !== undefined ? c.cardBack : s.cardBack, tableFelt: c.tableFelt !== undefined ? c.tableFelt : s.tableFelt }));
  },
}));
