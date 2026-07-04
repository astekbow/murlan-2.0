import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useLangStore } from '../lib/i18n.ts';

// Full-render test of the money view with mocked stores/api. Proves the wallet renders
// and — the key money-safety property — a withdrawal is gated behind a confirmation.
const h = vi.hoisted(() => {
  const withdraw = vi.fn().mockResolvedValue(true);
  const state: any = {
    balanceCents: 5000, transactions: [], withdrawals: [], profile: null,
    error: null, notice: null, loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
    deposit: vi.fn(), withdraw, setProfile: vi.fn(),
    selfExclude: vi.fn().mockResolvedValue(undefined), clearMessages: vi.fn(),
  };
  return { withdraw, state };
});

vi.mock('../store/walletStore.ts', () => {
  const hook: any = () => h.state;
  hook.setState = vi.fn((p: any) => Object.assign(h.state, typeof p === 'function' ? p(h.state) : p));
  hook.getState = () => h.state;
  return { useWalletStore: hook };
});
vi.mock('../store/authStore.ts', () => {
  const st = { accessToken: 'tok', user: { id: 'me' } };
  const hook: any = (sel?: any) => (sel ? sel(st) : st);
  hook.getState = () => st;
  hook.setState = vi.fn();
  return { useAuthStore: hook };
});
vi.mock('../lib/api.ts', async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    walletApi: { ...actual.walletApi, depositAddress: vi.fn().mockResolvedValue({ address: 'TDEPOSITADDR' }) },
    accountApi: {
      ...actual.accountApi,
      getLimits: vi.fn().mockResolvedValue({ limits: { dailyDepositLimitCents: null, dailyLossLimitCents: null } }),
      rgStatus: vi.fn().mockResolvedValue({ status: { dailyDepositLimitCents: null, dailyLossLimitCents: null, depositUsedTodayCents: 0, lossTodayCents: 0 } }),
    },
  };
});

beforeEach(() => useLangStore.setState({ lang: 'en' }));

test('WalletView renders and gates a withdrawal behind a confirmation dialog', async () => {
  const { WalletView } = await import('./WalletView.tsx');
  render(<WalletView />);

  // The money view rendered (the Withdraw section is present).
  expect(await screen.findByText('WITHDRAW')).toBeTruthy();

  // Fill a valid destination (the amount defaults to 5); then request the withdrawal.
  fireEvent.change(screen.getByPlaceholderText('your USDT (TRC20) address'), {
    target: { value: 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6' },
  });
  fireEvent.click(screen.getByText('Request withdrawal'));

  // The safety gate appears — money never moves on a single tap.
  expect(await screen.findByText('Confirm withdrawal')).toBeTruthy();

  // Confirming forwards to the store's withdraw with the parsed amount + destination.
  const reqButtons = screen.getAllByText('Request withdrawal'); // trigger + dialog confirm
  fireEvent.click(reqButtons[reqButtons.length - 1]!);
  await waitFor(() => expect(h.withdraw).toHaveBeenCalledWith(500, 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6'));
});

test('WalletView gates the deposit TxID button until a valid 64-hex hash is entered', async () => {
  const { WalletView } = await import('./WalletView.tsx');
  render(<WalletView />);
  // The deposit section (with the TxID fallback in a <details>) renders after the address loads.
  const txInput = await screen.findByLabelText('Transaction TxID') as HTMLInputElement;
  const confirmBtn = screen.getByRole('button', { name: 'Confirm deposit', hidden: true }) as HTMLButtonElement;
  expect(confirmBtn.disabled).toBe(true); // empty → disabled

  fireEvent.change(txInput, { target: { value: 'not-a-valid-hash' } });
  expect(confirmBtn.disabled).toBe(true); // malformed → still disabled (no confusing backend reject)

  fireEvent.change(txInput, { target: { value: 'a'.repeat(64) } });
  expect(confirmBtn.disabled).toBe(false); // 64 hex chars → enabled
});

test('WalletView surfaces a store error in an assertive alert banner', async () => {
  h.state.error = 'Deposit failed';
  try {
    const { WalletView } = await import('./WalletView.tsx');
    render(<WalletView />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Deposit failed');
  } finally {
    h.state.error = null;
  }
});
