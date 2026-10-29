import { create } from 'zustand';
import {
  authApi,
  ApiError,
  isSessionDead,
  refreshAccessToken,
  refreshSession,
  registerSessionHandlers,
  reportSessionLost,
  tokenLifetimeMs,
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

// Proactive access-token refresh, timed from the token's OWN lifetime (iat→exp) rather than a
// hard-coded guess: the old fixed 12-min timer assumed a 15m token while the server defaults to
// 5m, so every cycle left ~7 minutes on a dead token — REST calls 401'd and socket reconnects
// were refused (the "kicked out" reports). Refresh at 75% of the lifetime so a live token is
// always on hand. Timed from when WE received it, so a wrong phone clock can't skew it.
const REFRESH_AT = 0.75;
const FALLBACK_LIFETIME_MS = 5 * 60 * 1000; // server default ACCESS_TTL, if the token is unreadable
const RETRY_TRANSIENT_MS = 20_000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let tokenReceivedAt = 0;
let tokenLifetime = FALLBACK_LIFETIME_MS;
let proactiveOn = false;

function clearRefreshTimer(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

/** Note a freshly-received access token and (re)arm the timer for it. */
function armRefresh(token: string): void {
  tokenReceivedAt = Date.now();
  tokenLifetime = tokenLifetimeMs(token) ?? FALLBACK_LIFETIME_MS;
  if (!proactiveOn) return;
  clearRefreshTimer();
  refreshTimer = setTimeout(() => void runProactiveRefresh(), Math.max(10_000, tokenLifetime * REFRESH_AT));
}

async function runProactiveRefresh(): Promise<void> {
  clearRefreshTimer();
  try {
    await refreshAccessToken(); // → onToken → armRefresh(new token)
  } catch (e) {
    if (isSessionDead(e)) { reportSessionLost(); return; }
    // Network blip / server restart / 429: stay signed in and try again shortly.
    if (proactiveOn) refreshTimer = setTimeout(() => void runProactiveRefresh(), RETRY_TRANSIENT_MS);
  }
}

function startProactiveRefresh(token: string): void {
  proactiveOn = true;
  armRefresh(token);
}

function stopProactiveRefresh(): void {
  proactiveOn = false;
  clearRefreshTimer();
}

// Phones freeze timers while the app is in the background, so on RETURN the token is often
// already stale. Refresh straight away (before the socket's reconnect handshake needs it).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !proactiveOn) return;
    if (Date.now() - tokenReceivedAt >= tokenLifetime * REFRESH_AT) void runProactiveRefresh();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      startProactiveRefresh(accessToken);
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
      startProactiveRefresh(accessToken);
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
    // A transient failure (network / 5xx / 429 rate limit) is retried a couple of times before
    // giving up to the "offline — retry" screen. Only a genuine 401 (no / dead cookie) shows the
    // login form — a 429 used to land players on the login screen as if they'd been logged out.
    for (let attempt = 0; ; attempt++) {
      try {
        // Single-flight refresh (audit 2026-07-05): shares the ONE in-flight /auth/refresh with the
        // 401-retry, timer and socket paths.
        const { user, accessToken } = await refreshSession();
        set({ user, accessToken, status: 'authed' });
        startProactiveRefresh(accessToken);
        break;
      } catch (e) {
        const transient = e instanceof ApiError && (e.code === 'network' || e.status >= 500 || e.status === 429);
        if (transient && attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        set({ status: transient ? 'offline' : 'idle' });
        break;
      }
    }
    set({ bootstrapped: true });
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
    armRefresh(accessToken); // every fresh token (timer, 401-retry, socket, boot) re-arms the timer
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
