import { create } from 'zustand';
import {
  walletApi, accountApi, ApiError,
  type Transaction, type WithdrawalRecord, type DepositIntent, type ComplianceProfile,
} from '../lib/api.ts';
import { useAuthStore } from './authStore.ts';

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
      set({ loading: false, error: e instanceof ApiError ? e.message : 'Ngarkimi i kuletës dështoi.' });
    }
  },

  async deposit(amountCents) {
    const t = token();
    if (!t) return;
    set({ error: null, notice: null });
    try {
      const intent = await walletApi.deposit(t, amountCents);
      set({ lastIntent: intent, notice: 'Adresa e pagesës u krijua. Pagesa kreditohet automatikisht pas konfirmimit.' });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Depozita dështoi.' });
    }
  },

  async withdraw(amountCents, destination) {
    const t = token();
    if (!t) return false;
    set({ error: null, notice: null });
    try {
      await walletApi.withdraw(t, amountCents, destination);
      set({ notice: 'Kërkesa për tërheqje u dërgua dhe pret aprovim.' });
      await get().refresh();
      return true;
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Tërheqja dështoi.' });
      return false;
    }
  },

  async setProfile(dateOfBirth, country) {
    const t = token();
    if (!t) return;
    set({ error: null, notice: null });
    try {
      await accountApi.setProfile(t, { dateOfBirth: dateOfBirth || undefined, country: country || undefined });
      set({ notice: 'Profili u ruajt.' });
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Ruajtja e profilit dështoi.' });
    }
  },

  async selfExclude(days) {
    const t = token();
    if (!t) return;
    set({ error: null, notice: null });
    try {
      await accountApi.selfExclude(t, days);
      set({ notice: 'Vetëpërjashtimi u aktivizua.' });
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : 'Veprimi dështoi.' });
    }
  },

  clearMessages() {
    set({ error: null, notice: null });
  },
}));
