import { create } from 'zustand';
import { adminApi, ApiError, type AdminUser, type AdminWithdrawal, type AdminMatch } from '../lib/api.ts';
import { useAuthStore } from './authStore.ts';

function token(): string | null {
  return useAuthStore.getState().accessToken;
}

interface AdminStore {
  users: AdminUser[];
  withdrawals: AdminWithdrawal[];
  matches: AdminMatch[];
  loading: boolean;
  error: string | null;
  notice: string | null;

  refresh: () => Promise<void>;
  adjust: (id: string, deltaCents: number, reason: string) => Promise<void>;
  setKyc: (id: string, status: 'none' | 'pending' | 'verified') => Promise<void>;
  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
}

function err(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

export const useAdminStore = create<AdminStore>((set, get) => ({
  users: [],
  withdrawals: [],
  matches: [],
  loading: false,
  error: null,
  notice: null,

  async refresh() {
    const t = token();
    if (!t) return;
    set({ loading: true, error: null });
    try {
      const [u, w, m] = await Promise.all([adminApi.users(t), adminApi.withdrawals(t), adminApi.matches(t)]);
      set({ users: u.users, withdrawals: w.withdrawals, matches: m.matches, loading: false });
    } catch (e) {
      set({ loading: false, error: err(e, 'Ngarkimi i panelit dështoi.') });
    }
  },

  async adjust(id, deltaCents, reason) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.adjust(t, id, deltaCents, reason);
      set({ notice: 'Bilanci u rregullua.' });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'Rregullimi dështoi.') });
    }
  },

  async setKyc(id, status) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.setKyc(t, id, status);
      set({ notice: 'KYC u përditësua.' });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'Përditësimi i KYC dështoi.') });
    }
  },

  async approve(id) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.approveWithdrawal(t, id);
      set({ notice: 'Tërheqja u aprovua.' });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'Aprovimi dështoi.') });
    }
  },

  async reject(id) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.rejectWithdrawal(t, id);
      set({ notice: 'Tërheqja u refuzua (fondet u kthyen).' });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'Refuzimi dështoi.') });
    }
  },
}));
