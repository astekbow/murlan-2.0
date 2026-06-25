import { create } from 'zustand';
import { adminApi, ApiError, type AdminUser, type AdminWithdrawal, type AdminMatch, type TreasurySnapshot } from '../lib/api.ts';
import { useAuthStore } from './authStore.ts';
import { translate, useLangStore } from '../lib/i18n.ts';

const tr = (key: string) => translate(key, useLangStore.getState().lang);
const trp = (key: string, params: Record<string, string | number>) => translate(key, useLangStore.getState().lang, params);

function token(): string | null {
  return useAuthStore.getState().accessToken;
}

interface AdminStore {
  users: AdminUser[];
  withdrawals: AdminWithdrawal[];
  matches: AdminMatch[];
  revenueCents: number | null; // total house rake collected
  treasury: TreasurySnapshot | null; // on-demand (hits Binance/TronGrid)
  treasuryLoading: boolean;
  loading: boolean;
  error: string | null;
  notice: string | null;

  // Server-side user-list search / sort / pagination (was all client-side over the full list).
  userQuery: string;
  userSort: 'balance' | 'name';
  userOffset: number;
  userTotal: number;       // filtered total (for "showing X of Y" + prev/next)
  userPageSize: number;
  loadUsers: () => Promise<void>;
  setUserQuery: (q: string) => void;
  setUserSort: (s: 'balance' | 'name') => void;
  setUserPage: (offset: number) => void;

  refresh: () => Promise<void>;
  loadTreasury: () => Promise<void>;
  adjust: (id: string, deltaCents: number, reason: string) => Promise<void>;
  setKyc: (id: string, status: 'none' | 'pending' | 'verified') => Promise<void>;
  setRole: (id: string, role: 'user' | 'admin') => Promise<void>;
  approve: (id: string) => Promise<void>;
  approveMany: (ids: string[]) => Promise<string[]>; // bulk approve; returns the ids that FAILED
  reject: (id: string, reason?: string) => Promise<void>;
}

// ApiError.message is already localized by api.ts; localize the non-ApiError fallback key.
function err(e: unknown, fallbackKey: string): string {
  return e instanceof ApiError ? e.message : tr(fallbackKey);
}

export const useAdminStore = create<AdminStore>((set, get) => ({
  users: [],
  withdrawals: [],
  matches: [],
  revenueCents: null,
  treasury: null,
  treasuryLoading: false,
  loading: false,
  error: null,
  notice: null,

  userQuery: '',
  userSort: 'balance',
  userOffset: 0,
  userTotal: 0,
  userPageSize: 50,

  async loadUsers() {
    const t = token();
    if (!t) return;
    const { userQuery, userSort, userOffset, userPageSize } = get();
    try {
      const u = await adminApi.users(t, { q: userQuery || undefined, sort: userSort, limit: userPageSize, offset: userOffset });
      set({ users: u.users, userTotal: u.total });
    } catch (e) {
      set({ error: err(e, 'err.adminPanelLoadFailed') });
    }
  },

  setUserQuery(q) { set({ userQuery: q, userOffset: 0 }); void get().loadUsers(); },
  setUserSort(s) { set({ userSort: s }); void get().loadUsers(); },
  setUserPage(offset) { set({ userOffset: Math.max(0, offset) }); void get().loadUsers(); },

  async refresh() {
    const t = token();
    if (!t) return;
    set({ loading: true, error: null });
    try {
      const [w, m, r] = await Promise.all([adminApi.withdrawals(t), adminApi.matches(t), adminApi.revenue(t)]);
      set({ withdrawals: w.withdrawals, matches: m.matches, revenueCents: r.totalRakeCents, loading: false });
      await get().loadUsers();
    } catch (e) {
      set({ loading: false, error: err(e, 'err.adminPanelLoadFailed') });
    }
  },

  async loadTreasury() {
    const t = token();
    if (!t) return;
    set({ treasuryLoading: true, error: null });
    try {
      set({ treasury: await adminApi.treasury(t), treasuryLoading: false });
    } catch (e) {
      set({ treasuryLoading: false, error: err(e, 'err.adminPanelLoadFailed') });
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

  async setRole(id, role) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.setRole(t, id, role);
      set({ notice: tr('msg.roleUpdated') });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'err.roleUpdateFailed') });
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
  async approveMany(ids) {
    const t = token();
    if (!t) return ids; // no session → treat all as failed (nothing approved)
    const failed: string[] = [];
    // Sequential so a burst can't race the payout provider; each is the proven idempotent path.
    for (const id of ids) {
      try { await adminApi.approveWithdrawal(t, id); }
      catch { failed.push(id); }
    }
    await get().refresh();
    const ok = ids.length - failed.length;
    if (failed.length === 0) set({ notice: trp('msg.withdrawApprovedN', { n: ok }), error: null });
    else set({ error: trp('err.approveSomeFailed', { ok, total: ids.length }), notice: null });
    return failed;
  },

  async reject(id, reason) {
    const t = token();
    if (!t) return;
    try {
      await adminApi.rejectWithdrawal(t, id, reason);
      set({ notice: tr('msg.withdrawRejected') });
      await get().refresh();
    } catch (e) {
      set({ error: err(e, 'err.rejectFailed') });
    }
  },
}));
