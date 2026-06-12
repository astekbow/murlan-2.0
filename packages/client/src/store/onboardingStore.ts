import { create } from 'zustand';

// First-run onboarding flag. Device-local (not per-account) — a returning player
// on a fresh device sees the welcome once. Cleared value = never onboarded.
const KEY = 'murlan.onboarded.v1';

function loadDone(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return true; /* private mode: don't nag */ }
}

interface OnboardingStore {
  done: boolean;
  complete: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set) => ({
  done: loadDone(),
  complete() {
    try { localStorage.setItem(KEY, '1'); } catch { /* private mode */ }
    set({ done: true });
  },
}));
