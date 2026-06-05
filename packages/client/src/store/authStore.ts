import { create } from 'zustand';
import {
  authApi,
  ApiError,
  refreshAccessToken,
  registerSessionHandlers,
  type PublicUser,
  type RegisterInput,
  type LoginInput,
} from '../lib/api.ts';
import { useUiStore } from './uiStore.ts';
import { translate, useLangStore } from '../lib/i18n.ts';

// Localized text for store actions (outside React render). ApiError.message is
// already localized by api.ts; this covers the non-ApiError fallbacks.
const tr = (key: string) => translate(key, useLangStore.getState().lang);

interface AuthStore {
  user: PublicUser | null;
  accessToken: string | null;
  status: 'idle' | 'loading' | 'authed' | 'error' | 'offline';
  error: string | null;
  bootstrapped: boolean;

  register: (input: RegisterInput) => Promise<boolean>;
  login: (input: LoginInput) => Promise<boolean>;
  logout: () => Promise<void>;
  bootstrap: () => Promise<void>;
  refreshMe: () => Promise<void>;
  clearError: () => void;
}

// The access token TTL is 15 minutes (server config). Refresh well inside that
// window so REST calls and socket (re)connects always carry a live token.
const PROACTIVE_REFRESH_MS = 12 * 60 * 1000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function startProactiveRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshAccessToken().catch(() => {
      /* a failed proactive refresh surfaces on the next real call / reconnect */
    });
  }, PROACTIVE_REFRESH_MS);
}

function stopProactiveRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  accessToken: null,
  status: 'idle',
  error: null,
  bootstrapped: false,

  async register(input) {
    set({ status: 'loading', error: null });
    try {
      const { user, accessToken } = await authApi.register(input);
      set({ user, accessToken, status: 'authed' });
      startProactiveRefresh();
      return true;
    } catch (e) {
      set({ status: 'error', error: e instanceof ApiError ? e.message : tr('err.registerFailed') });
      return false;
    }
  },

  async login(input) {
    set({ status: 'loading', error: null });
    try {
      const { user, accessToken } = await authApi.login(input);
      set({ user, accessToken, status: 'authed' });
      startProactiveRefresh();
      return true;
    } catch (e) {
      set({ status: 'error', error: e instanceof ApiError ? e.message : tr('err.loginFailed') });
      return false;
    }
  },

  async logout() {
    stopProactiveRefresh();
    try {
      await authApi.logout();
    } catch {
      /* ignore network errors on logout */
    }
    useUiStore.getState().reset(); // don't leak the previous view to the next user
    set({ user: null, accessToken: null, status: 'idle', error: null });
  },

  // On app load, try to silently restore a session from the refresh cookie.
  // Distinguish "no session" (genuine 401) from "server unreachable" (network /
  // 5xx) so a logged-in user with a valid cookie isn't bounced to login on a blip.
  async bootstrap() {
    try {
      const { user, accessToken } = await authApi.refresh();
      set({ user, accessToken, status: 'authed' });
      startProactiveRefresh();
    } catch (e) {
      const transient = e instanceof ApiError && (e.code === 'network' || e.status >= 500);
      set({ status: transient ? 'offline' : 'idle' });
    } finally {
      set({ bootstrapped: true });
    }
  },

  // Re-read the authoritative profile (incl. balanceCents) — e.g. after a match
  // settles — so the balance chip can count up to the new figure. Read-only.
  async refreshMe() {
    const token = get().accessToken;
    if (!token) return;
    try {
      const { user } = await authApi.me(token);
      set({ user });
    } catch {
      /* ignore — keep the last known profile */
    }
  },

  clearError() {
    set({ error: null });
  },
}));

// Bridge the api layer's silent-refresh machinery into the store: a refreshed
// token updates state (so the socket auth callback reads the live token); a lost
// session (refresh cookie expired/revoked) drops to the login screen cleanly.
registerSessionHandlers({
  onToken: (accessToken) => {
    if (useAuthStore.getState().accessToken !== accessToken) useAuthStore.setState({ accessToken });
  },
  onLost: () => {
    stopProactiveRefresh();
    useUiStore.getState().reset();
    useAuthStore.setState({
      user: null,
      accessToken: null,
      status: 'idle',
      error: tr('err.session_expired'),
    });
  },
});
