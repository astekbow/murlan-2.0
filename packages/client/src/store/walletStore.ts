import { create } from 'zustand';
import {
  walletApi, accountApi, ApiError,
  type Transaction, type WithdrawalRecord, type DepositIntent, type ComplianceProfile,
} from '../lib/api.ts';
import { useAuthStore } from './authStore.ts';
import { translate, useLangStore } from '../lib/i18n.ts';

// Localized text for store actions (ApiError.message is already localized by api.ts).
const tr = (key: string) => translate(key, useLangStore.getState().lang);

function token(): string | null {
  return useAuthStore.getState().accessToken;
}

interface WalletStore {
  balanceCents: number;
  transactions: Transaction[];
  withdrawals: WithdrawalRecord[];
  profile: ComplianceProfile | null;
  lastIntent: DepositIntent | null;
  loading: boolean;
  error: string | null;
  notice: string | null;

  refresh: () => Promise<void>;
  deposit: (amountCents: number) => Promise<void>;
  withdraw: (amountCents: number, destination: string) => Promise<boolean>;
  setProfile: (dateOfBirth: string, country: string) => Promise<void>;
  selfExclude: (days: number) => Promise<void>;
  clearMessages: () => void;
}

export const useWalletStore = create<WalletStore>((set, get) => ({
  balanceCents: 0,
  transactions: [],
  withdrawals: [],
  profile: null,
  lastIntent: null,
  loading: false,
  error: null,
  notice: null,

  async refresh() {
    const t = token();
    if (!t) return;
    set({ loading: true, error: null });
    try {
      const [bal, txs, wds, acct] = await Promise.all([
        walletApi.balance(t),
        walletApi.transactions(t),
        walletApi.withdrawals(t),
        accountApi.get(t),
      ]);
      set({
        balanceCents: bal.balanceCents,
        transactions: [...txs.transactions].reverse(),
        withdrawals: [...wds.withdrawals].reverse(),
        profile: acct.profile,
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof ApiError ? e.message : tr('err.walletLoadFailed') });
    }
  },

  async deposit(amountCents) {
    const t = token();
    if (!t) return;
    set({ error: null, notice: null });
    try {
      const intent = await walletApi.deposit(t, amountCents);
      set({ lastIntent: intent, notice: tr('msg.depositAddressCreated') });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : tr('err.depositFailed') });
    }
  },

  async withdraw(amountCents, destination) {
    const t = token();
    if (!t) return false;
    set({ error: null, notice: null });
    try {
      await walletApi.withdraw(t, amountCents, destination);
      set({ notice: tr('msg.withdrawRequested') });
      await get().refresh();
      return true;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : tr('err.withdrawFailed') });
      return false;
    }
  },

  async setProfile(dateOfBirth, country) {
    const t = token();
    if (!t) return;
    set({ error: null, notice: null });
    try {
      await accountApi.setProfile(t, { dateOfBirth: dateOfBirth || undefined, country: country || undefined });
      set({ notice: tr('msg.profileSaved') });
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : tr('err.profileSaveFailed') });
    }
  },

  async selfExclude(days) {
    const t = token();
    if (!t) return;
    set({ error: null, notice: null });
    try {
      await accountApi.selfExclude(t, days);
      set({ notice: tr('msg.selfExcludeActivated') });
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : tr('err.actionFailed') });
    }
  },

  clearMessages() {
    set({ error: null, notice: null });
  },
}));
