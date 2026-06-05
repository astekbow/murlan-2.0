import { create } from 'zustand';
import { adminApi, ApiError, type AdminUser, type AdminWithdrawal, type AdminMatch } from '../lib/api.ts';
import { useAuthStore } from './authStore.ts';
import { translate, useLangStore } from '../lib/i18n.ts';

const tr = (key: string) => translate(key, useLangStore.getState().lang);

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

// ApiError.message is already localized by api.ts; localize the non-ApiError fallback key.
function err(e: unknown, fallbackKey: string): string {
  return e instanceof ApiError ? e.message : tr(fallbackKey);
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
      set({ loading: false, error: err(e, 'err.adminPanelLoadFailed') });
    }
  },

  async adjust(id, deltaCents, reason) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.adjust(t, id, deltaCents, reason);
      set({ notice: tr('msg.balanceAdjusted') });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'err.adjustFailed') });
    }
  },

  async setKyc(id, status) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.setKyc(t, id, status);
      set({ notice: tr('msg.kycUpdated') });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'err.kycUpdateFailed') });
    }
  },

  async approve(id) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.approveWithdrawal(t, id);
      set({ notice: tr('msg.withdrawApproved') });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'err.approveFailed') });
    }
  },

  async reject(id) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.rejectWithdrawal(t, id);
      set({ notice: tr('msg.withdrawRejected') });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'err.rejectFailed') });
    }
  },
}));
