import { useEffect, useState, Suspense, type ReactNode } from 'react';
import { useAuthStore } from './store/authStore.ts';
import { useGameStore } from './store/gameStore.ts';
import { useUiStore } from './store/uiStore.ts';
import { authApi } from './lib/api.ts';
import { AuthView } from './views/AuthView.tsx';
import { ResetPasswordView } from './views/ResetPasswordView.tsx';
import { LobbyView } from './views/LobbyView.tsx';
import { Toast } from './components/Toast.tsx';
import { Background } from './components/ui/Background.tsx';
import { TopBar } from './components/ui/TopBar.tsx';
import { InviteBanner } from './components/ui/InviteBanner.tsx';
import { ReconnectOverlay } from './components/ui/ReconnectOverlay.tsx';
import { ErrorBoundary } from './components/ui/ErrorBoundary.tsx';
import { lazyWithRetry } from './lib/lazyWithRetry.ts';
import { useCosmeticsStore } from './store/cosmeticsStore.ts';

// Code-split the heavier / less-frequent views so the initial lobby payload
// stays small (loaded on demand with a Suspense fallback; retried once on a
// transient chunk-load failure).
const TableView = lazyWithRetry(() => import('./views/TableView.tsx').then((m) => ({ default: m.TableView })));
const RoomView = lazyWithRetry(() => import('./views/RoomView.tsx').then((m) => ({ default: m.RoomView })));
const WalletView = lazyWithRetry(() => import('./views/WalletView.tsx').then((m) => ({ default: m.WalletView })));
const AdminView = lazyWithRetry(() => import('./views/AdminView.tsx').then((m) => ({ default: m.AdminView })));
const LeaderboardView = lazyWithRetry(() => import('./views/LeaderboardView.tsx').then((m) => ({ default: m.LeaderboardView })));
const FriendsView = lazyWithRetry(() => import('./views/FriendsView.tsx').then((m) => ({ default: m.FriendsView })));
const ShopView = lazyWithRetry(() => import('./views/ShopView.tsx').then((m) => ({ default: m.ShopView })));
const RewardsView = lazyWithRetry(() => import('./views/RewardsView.tsx').then((m) => ({ default: m.RewardsView })));

function Splash({ text }: { text: string }) {
  return (
    <div className="min-h-full flex items-center justify-center">
      <div className="font-display text-lg tracking-wide text-muted animate-pop">{text}</div>
    </div>
  );
}

/** Shown when bootstrap couldn't reach the server (vs. genuinely no session) —
 *  a logged-in user with a valid cookie can retry instead of being sent to login. */
function OfflineSplash({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-4xl">📡</div>
      <div className="font-display text-lg tracking-wide text-txt">S'u lidh dot me serverin</div>
      <div className="text-sm text-muted max-w-xs">Kontrollo internetin. Sesioni yt ruhet — provo sërish.</div>
      <button className="btn btn-gold" onClick={onRetry}>Provo sërish</button>
    </div>
  );
}

/** Lobby-area chrome: centered column with the global top bar on top. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-10 mx-auto w-full max-w-[1180px] px-4 pt-4 pb-14">
      <TopBar />
      {children}
    </div>
  );
}

export function App() {
  const { status, accessToken, user, bootstrap, bootstrapped } = useAuthStore();
  const { socket, room, connect, disconnect, toast, toastKind, dismissToast } = useGameStore();
  const lobbyView = useUiStore((s) => s.view);

  // Email-link entry points (?resetPassword=… / ?verifyEmail=…). Captured once on
  // load; the param is stripped from the URL after handling.
  const [resetToken, setResetToken] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('resetPassword'),
  );
  const clearQuery = () => window.history.replaceState({}, '', window.location.pathname);

  // Restore a session from the refresh cookie on first load.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Handle an email-verification link on load (independent of session).
  useEffect(() => {
    const verify = new URLSearchParams(window.location.search).get('verifyEmail');
    if (!verify) return;
    void authApi
      .confirmEmail(verify)
      .then(() => useGameStore.setState({ toast: 'Email-i u verifikua! 🎉', toastKind: 'success' }))
      .catch(() => useGameStore.setState({ toast: 'Lidhja e verifikimit s’është e vlefshme ose ka skaduar.', toastKind: 'error' }))
      .finally(clearQuery);
  }, []);

  // Open the socket once authenticated; tear it down on logout. The socket reads
  // the live access token on every (re)connect via the getter, so a token
  // refreshed mid-session is used automatically.
  useEffect(() => {
    if (status === 'authed' && accessToken && user && !socket) {
      connect(() => useAuthStore.getState().accessToken, user.id);
    } else if (status !== 'authed' && socket) {
      disconnect();
    }
  }, [status, accessToken, user, socket, connect, disconnect]);

  // Load equipped cosmetics (felt theme / card-back) once signed in.
  useEffect(() => {
    if (status === 'authed' && accessToken) void useCosmeticsStore.getState().load(accessToken);
  }, [status, accessToken]);

  let body: ReactNode;
  if (resetToken) body = <ResetPasswordView token={resetToken} onDone={() => { setResetToken(null); clearQuery(); }} />;
  else if (!bootstrapped) body = <Splash text="Duke u ngarkuar…" />;
  else if (status === 'offline') body = <OfflineSplash onRetry={() => void bootstrap()} />;
  else if (status !== 'authed') body = <AuthView />;
  else if (room && (room.status === 'inMatch' || room.status === 'finished')) body = <TableView room={room} />;
  else if (room) body = <Shell><RoomView room={room} /></Shell>;
  else if (lobbyView === 'wallet') body = <Shell><WalletView /></Shell>;
  else if (lobbyView === 'admin' && user?.role === 'admin') body = <Shell><AdminView /></Shell>;
  else if (lobbyView === 'leaderboard') body = <Shell><LeaderboardView /></Shell>;
  else if (lobbyView === 'friends') body = <Shell><FriendsView /></Shell>;
  else if (lobbyView === 'shop') body = <Shell><ShopView /></Shell>;
  else if (lobbyView === 'rewards') body = <Shell><RewardsView /></Shell>;
  else body = <Shell><LobbyView /></Shell>;

  return (
    <ErrorBoundary>
      <Background />
      <Suspense fallback={<Splash text="Duke u ngarkuar…" />}>{body}</Suspense>
      {status === 'authed' && <InviteBanner />}
      {status === 'authed' && <ReconnectOverlay />}
      <Toast message={toast} kind={toastKind} onDismiss={dismissToast} />
    </ErrorBoundary>
  );
}
