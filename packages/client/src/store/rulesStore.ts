import { create } from 'zustand';

// Tiny UI store for the "How to play" (rules) modal — openable from the lobby + onboarding.
interface RulesStore {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useRulesStore = create<RulesStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
