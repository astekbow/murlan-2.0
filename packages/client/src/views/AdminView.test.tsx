import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useLangStore } from '../lib/i18n.ts';

// Render smoke test of the admin panel with a fully mocked admin store + API. Proves
// the (large) view mounts and its tab bar renders without hitting the network.
const adminState: any = {
  users: [], withdrawals: [], matches: [], revenueCents: 0, error: null, notice: null,
  treasury: null, treasuryLoading: false,
  userSort: 'newest', userOffset: 0, userTotal: 0, userPageSize: 20,
  refresh: vi.fn().mockResolvedValue(undefined),
  loadTreasury: vi.fn().mockResolvedValue(undefined),
  approve: vi.fn(), reject: vi.fn(), adjust: vi.fn(), setRole: vi.fn(),
  setUserQuery: vi.fn(), setUserSort: vi.fn(), setUserPage: vi.fn(),
};

vi.mock('../store/adminStore.ts', () => {
  const hook: any = () => adminState;
  hook.getState = () => adminState;
  hook.setState = vi.fn();
  return { useAdminStore: hook };
});
vi.mock('../store/authStore.ts', () => {
  const st = { accessToken: 'tok', user: { id: 'admin1' } };
  const hook: any = (sel?: any) => (sel ? sel(st) : st);
  hook.getState = () => st;
  hook.setState = vi.fn();
  return { useAuthStore: hook };
});
vi.mock('../lib/api.ts', async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      support: vi.fn().mockResolvedValue({ tickets: [] }),
      audit: vi.fn().mockResolvedValue({ actions: [] }),
      chatReports: vi.fn().mockResolvedValue({ reports: [] }),
      revenueBreakdown: vi.fn().mockResolvedValue({ byDay: [], byType: [] }),
    },
    rankedApi: { ...actual.rankedApi, season: vi.fn().mockResolvedValue({ season: null }) },
  };
});

beforeEach(() => useLangStore.setState({ lang: 'en' }));

test('AdminView mounts and renders its tab bar with a mocked store', async () => {
  const { AdminView } = await import('./AdminView.tsx');
  render(<AdminView />);
  // The tab bar rendered (Overview is the default tab) → the panel mounted cleanly.
  expect(await screen.findByText('Overview')).toBeTruthy();
  // The ranked-season admin control (added this session) is present on the overview.
  expect(await screen.findByText('Ranked season')).toBeTruthy();
});
