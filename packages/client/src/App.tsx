import { useCallback, useEffect, useState, Suspense, type ReactNode } from 'react';
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
import { RankedSearchOverlay } from './components/ui/RankedSearchOverlay.tsx';
import { RealityCheckModal } from './components/ui/RealityCheckModal.tsx';
import { ReconnectOverlay } from './components/ui/ReconnectOverlay.tsx';
import { InstallModal } from './components/ui/InstallModal.tsx';
import { OnboardingModal } from './components/ui/OnboardingModal.tsx';
import { ViewTransition } from './components/ui/ViewTransition.tsx';
import { useOnboardingStore } from './store/onboardingStore.ts';
import { useUrlSync } from './lib/useUrlSync.ts';
import { takePendingJoinCode, takePendingProfileId } from './lib/deepLink.ts';
import { ProfileModal } from './components/ui/ProfileModal.tsx';
import { useExitGuard } from './lib/useExitGuard.ts';
import { ConfirmDialog } from './components/ui/ConfirmDialog.tsx';
import { dollars } from './lib/money.ts';
import { ErrorBoundary } from './components/ui/ErrorBoundary.tsx';
import { lazyWithRetry } from './lib/lazyWithRetry.ts';
import { useCosmeticsStore } from './store/cosmeticsStore.ts';
import { useT, translate, useLangStore } from './lib/i18n.ts';
import { maybeSubscribePush } from './lib/push.ts';

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
const SupportView = lazyWithRetry(() => import('./views/SupportView.tsx').then((m) => ({ default: m.SupportView })));
const VipView = lazyWithRetry(() => import('./views/VipView.tsx').then((m) => ({ default: m.VipView })));
const ClubsView = lazyWithRetry(() => import('./views/ClubsView.tsx').then((m) => ({ default: m.ClubsView })));
const TournamentsView = lazyWithRetry(() => import('./views/TournamentsView.tsx').then((m) => ({ default: m.TournamentsView })));
const ReplayView = lazyWithRetry(() => import('./views/ReplayView.tsx').then((m) => ({ default: m.ReplayView })));
const SpectateView = lazyWithRetry(() => import('./views/SpectateView.tsx').then((m) => ({ default: m.SpectateView })));

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
  const t = useT();
  return (
    <div className="min-h-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-4xl">📡</div>
      <div className="font-display text-lg tracking-wide text-txt">{t('app.offlineTitle')}</div>
      <div className="text-sm text-muted max-w-xs">{t('app.offlineBody')}</div>
      <button className="btn btn-gold" onClick={onRetry}>{t('app.retry')}</button>
    </div>
  );
}

/** Lobby-area chrome: centered column with the global top bar on top. */
function Shell({ children }: { children: ReactNode }) {
  // Safe-area insets (notch / Dynamic Island / home indicator) + room for the
  // mobile bottom nav live in the `.app-shell` class (index.css) so a media query
  // can drop the extra bottom space on desktop. The page content fades on each
  // lobby-view switch via ViewTransition (TopBar persists).
  const view = useUiStore((s) => s.view);
  return (
    <div className="app-shell relative z-10 mx-auto w-full max-w-[1180px]">
      <TopBar />
      <main><ViewTransition viewKey={view}>{children}</ViewTransition></main>
    </div>
  );
}

export function App() {
  const { status, accessToken, user, bootstrap, bootstrapped } = useAuthStore();
  const { socket, room, spectating, connect, disconnect, toast, toastKind, dismissToast } = useGameStore();
  const lobbyView = useUiStore((s) => s.view);
  const replayMatchId = useUiStore((s) => s.replayMatchId);
  const profileUserId = useUiStore((s) => s.profileUserId);
  const onboarded = useOnboardingStore((s) => s.done);
  const t = useT();
  const connected = useGameStore((s) => s.connected);
  useUrlSync(); // lobby sub-views ↔ URL path: deep-linkable pages + working back button

  // Shareable room invite (/join/<CODE>): once the player is authenticated AND the
  // socket is connected and they're not already in a room, consume the captured code
  // and join. Fires at most once (takePendingJoinCode nulls it); joinByCode surfaces
  // a toast if the room is full/gone.
  useEffect(() => {
    if (status !== 'authed' || !connected) return;
    if (useGameStore.getState().room) return;
    const code = takePendingJoinCode();
    if (code) void useGameStore.getState().joinByCode(code);
  }, [status, connected]);

  // Shareable profile link (/u/<id>): open the captured profile once authenticated.
  useEffect(() => {
    if (status !== 'authed') return;
    const id = takePendingProfileId();
    if (id) useUiStore.getState().openProfile(id);
  }, [status]);

  // Android/browser BACK guard: while at a table, back must not exit the PWA or abandon a
  // staked match. Absorb it and prompt to leave instead (the explicit Leave button remains
  // the real exit). Spectators are excluded — they can back out freely.
  const [backLeave, setBackLeave] = useState(false);
  useExitGuard(!!room && !spectating, useCallback(() => {
    const r = useGameStore.getState().room;
    if (r && r.status === 'inMatch') setBackLeave(true); // mid-match → confirm (stake at risk)
    else void useGameStore.getState().leaveRoom();        // waiting/finished → just leave to lobby
  }, []));

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

  // Shareable provably-fair replay link (?replay=<matchId>). Opens the verifier
  // for anyone — no sign-in required — then strips the param from the URL.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('replay');
    if (r) {
      useUiStore.getState().openReplay(r);
      clearQuery();
    }
  }, []);

  // Handle an email-verification link on load (independent of session).
  useEffect(() => {
    const verify = new URLSearchParams(window.location.search).get('verifyEmail');
    if (!verify) return;
    void authApi
      .confirmEmail(verify)
      .then(() => useGameStore.setState({ toast: translate('app.emailVerified', useLangStore.getState().lang), toastKind: 'success' }))
      .catch(() => useGameStore.setState({ toast: translate('app.emailVerifyFailed', useLangStore.getState().lang), toastKind: 'error' }))
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

  // Refresh an already-granted Web Push subscription (no-op unless VAPID keys are
  // configured and the user previously opted in — never prompts).
  useEffect(() => {
    if (status === 'authed' && accessToken) void maybeSubscribePush(accessToken);
  }, [status, accessToken]);

  let body: ReactNode;
  // The provably-fair replay/verifier overrides everything and works unauthenticated
  // (public data) so a shared replay link opens for anyone.
  if (replayMatchId) body = <ReplayView matchId={replayMatchId} onClose={() => useUiStore.getState().closeReplay()} />;
  else if (resetToken) body = <ResetPasswordView token={resetToken} onDone={() => { setResetToken(null); clearQuery(); }} />;
  else if (!bootstrapped) body = <Splash text={t('app.loading')} />;
  else if (status === 'offline') body = <OfflineSplash onRetry={() => void bootstrap()} />;
  else if (status !== 'authed') body = <AuthView />;
  else if (spectating && room) body = <SpectateView room={room} />;
  else if (room && (room.status === 'inMatch' || room.status === 'finished')) body = <TableView room={room} />;
  else if (room) body = <Shell><RoomView room={room} /></Shell>;
  else if (lobbyView === 'wallet') body = <Shell><WalletView /></Shell>;
  else if (lobbyView === 'admin' && user?.role === 'admin') body = <Shell><AdminView /></Shell>;
  else if (lobbyView === 'leaderboard') body = <Shell><LeaderboardView /></Shell>;
  else if (lobbyView === 'friends') body = <Shell><FriendsView /></Shell>;
  else if (lobbyView === 'shop') body = <Shell><ShopView /></Shell>;
  else if (lobbyView === 'rewards') body = <Shell><RewardsView /></Shell>;
  else if (lobbyView === 'support') body = <Shell><SupportView /></Shell>;
  else if (lobbyView === 'vip') body = <Shell><VipView /></Shell>;
  else if (lobbyView === 'clubs') body = <Shell><ClubsView /></Shell>;
  else if (lobbyView === 'tournaments') body = <Shell><TournamentsView /></Shell>;
  else body = <Shell><LobbyView /></Shell>;

  return (
    <ErrorBoundary>
      <Background />
      <Suspense fallback={<Splash text={t('app.loading')} />}>{body}</Suspense>
      {status === 'authed' && <InviteBanner />}
      {/* First-run welcome takes precedence; the install prompt waits until it's done. */}
      {status === 'authed' && !room && !spectating && !onboarded && <OnboardingModal />}
      {status === 'authed' && !room && !spectating && onboarded && <InstallModal />}
      {status === 'authed' && <RankedSearchOverlay />}
      {status === 'authed' && <RealityCheckModal />}
      {status === 'authed' && <ReconnectOverlay />}
      {/* Global profile modal — opened by /u/<id> deep-links. */}
      {status === 'authed' && profileUserId && (
        <ProfileModal userId={profileUserId} onClose={() => useUiStore.getState().closeProfile()} />
      )}
      {backLeave && room && (
        <ConfirmDialog
          title={t('table.leaveConfirm')}
          message={room.stakeCents > 0 ? t('table.leaveStakeWarn', { amount: dollars(room.stakeCents) }) : t('table.leaveWarn')}
          confirmLabel={t('table.leave')}
          danger
          onConfirm={() => { setBackLeave(false); void useGameStore.getState().leaveRoom(); }}
          onClose={() => setBackLeave(false)}
        />
      )}
      <Toast message={toast} kind={toastKind} onDismiss={dismissToast} />
    </ErrorBoundary>
  );
}
