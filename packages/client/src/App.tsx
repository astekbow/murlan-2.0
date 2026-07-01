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
import { ClubInviteBanner } from './components/ui/ClubInviteBanner.tsx';
import { RankedSearchOverlay } from './components/ui/RankedSearchOverlay.tsx';
import { CookieNotice } from './components/ui/CookieNotice.tsx';
import { ReconnectOverlay } from './components/ui/ReconnectOverlay.tsx';
import { InstallModal } from './components/ui/InstallModal.tsx';
import { OnboardingModal } from './components/ui/OnboardingModal.tsx';
import { RulesModal } from './components/ui/RulesModal.tsx';
import { DailyStreakModal } from './components/ui/DailyStreakModal.tsx';
import { ViewTransition } from './components/ui/ViewTransition.tsx';
import { useOnboardingStore } from './store/onboardingStore.ts';
import { useUrlSync } from './lib/useUrlSync.ts';
import { useForceLandscapeApp } from './lib/useForceLandscapeApp.ts';
import { useKeyboardInset } from './lib/useKeyboardInset.ts';
import { RotateOverlay } from './components/ui/RotateOverlay.tsx';
import { takePendingJoinCode, takePendingProfileId } from './lib/deepLink.ts';
import { getResetToken, takeVerifyToken } from './lib/hashTokens.ts';
import { ProfileModal } from './components/ui/ProfileModal.tsx';
import { useExitGuard } from './lib/useExitGuard.ts';
import { ConfirmDialog } from './components/ui/ConfirmDialog.tsx';
import { dollars } from './lib/money.ts';
import { ErrorBoundary } from './components/ui/ErrorBoundary.tsx';
import { lazyWithRetry } from './lib/lazyWithRetry.ts';
import { useCosmeticsStore } from './store/cosmeticsStore.ts';
import { useSessionStore } from './store/sessionStore.ts';
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
function Shell({ children, bare = false }: { children: ReactNode; bare?: boolean }) {
  // Safe-area insets (notch / Dynamic Island / home indicator) + room for the
  // mobile bottom nav live in the `.app-shell` class (index.css) so a media query
  // can drop the extra bottom space on desktop. The page content fades on each
  // lobby-view switch via ViewTransition (TopBar persists).
  // `bare` hides the global TopBar — used by full-screen pages that have their OWN
  // header + Back button (Wallet, Support) so they aren't cramped on short landscape phones.
  const view = useUiStore((s) => s.view);
  const t = useT();
  return (
    <div className="app-shell relative z-10 mx-auto w-full max-w-[1180px]">
      {/* Keyboard a11y: jump past the persistent TopBar nav straight to the page content (WCAG 2.4.1). */}
      <a href="#main-content" className="skip-link">{t('a11y.skipToMain')}</a>
      {!bare && <TopBar />}
      {/* Inner Suspense so a lazy sub-view loads UNDER the persistent TopBar (only the main area shows the
          loader) instead of the outer full-screen Splash flashing the whole shell away on first navigation. */}
      <main id="main-content" tabIndex={-1} className="outline-none">
        <Suspense fallback={<div className="flex items-center justify-center py-24"><span className="text-3xl opacity-60 animate-twinkle" aria-hidden>🎴</span></div>}>
          <ViewTransition viewKey={view}>{children}</ViewTransition>
        </Suspense>
      </main>
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
  useKeyboardInset(); // keep the focused text field above the on-screen keyboard (iOS DM/chat composers etc.)
  // Phones + tablets are LANDSCAPE-ONLY: held portrait, the whole app is blocked by the rotate
  // prompt (no portrait UI at all). Desktops/laptops are unaffected — they render normally.
  const forceRotate = useForceLandscapeApp(); // true on a phone/tablet held PORTRAIT → show RotateOverlay

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

  // Email-link entry points (#resetPassword=… / #verifyEmail=…). The tokens were
  // captured + the fragment stripped SYNCHRONOUSLY at module load (hashTokens.ts), so by
  // the time React renders, the secret is already out of the URL/history.
  const [resetToken, setResetToken] = useState<string | null>(() => getResetToken());
  const clearQuery = () => window.history.replaceState({}, '', window.location.pathname + window.location.search);

  // Restore a session from the refresh cookie on first load.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Resume SPECTATING from a /watch/<roomId> deep-link or refresh, once authed + connected (mirrors the
  // /join/<code> handler). Read-only → no leave-guard. The provably-fair REPLAY route (/replay/<id> and
  // the legacy ?replay=<id> alias) is handled entirely by useUrlSync.
  useEffect(() => {
    if (status !== 'authed' || !connected) return;
    if (useGameStore.getState().room || useGameStore.getState().spectating) return;
    const m = /^\/watch\/(.+)$/.exec(window.location.pathname);
    if (m) void useGameStore.getState().spectate(decodeURIComponent(m[1]));
  }, [status, connected]);

  // Handle an email-verification link on load (independent of session). The token was
  // already captured from the fragment + stripped synchronously at module load, so we
  // just consume the captured value — no URL read, no late strip.
  useEffect(() => {
    const verify = takeVerifyToken();
    if (!verify) return;
    void authApi
      .confirmEmail(verify)
      .then(() => useGameStore.setState({ toast: translate('app.emailVerified', useLangStore.getState().lang), toastKind: 'success' }))
      .catch(() => useGameStore.setState({ toast: translate('app.emailVerifyFailed', useLangStore.getState().lang), toastKind: 'error' }));
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

  // Mobile resume recovery: returning from background / screen-wake can leave the socket stuck
  // "reconnecting" forever — the OS froze Socket.IO's backoff timer (or silently tore down the
  // transport), so it never retries until a full app relaunch. Force an immediate connect on
  // visibility/online/focus whenever the socket isn't connected — what previously only a restart did.
  useEffect(() => {
    const kick = () => {
      const s = useGameStore.getState().socket;
      if (s && !s.connected) s.connect();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', kick);
      window.removeEventListener('focus', kick);
    };
  }, []);

  // Responsible-gaming session clock: stamp the start time once signed in (idempotent
  // across token refreshes) and reset it when the session ends. Drives the TopBar
  // "Po luan: 42m" indicator.
  useEffect(() => {
    if (status === 'authed') useSessionStore.getState().start();
    else useSessionStore.getState().clear();
  }, [status]);

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
  else if (lobbyView === 'wallet') body = <Shell bare><WalletView /></Shell>;
  else if (lobbyView === 'admin' && user?.role === 'admin') body = <Shell><AdminView /></Shell>;
  else if (lobbyView === 'leaderboard') body = <Shell><LeaderboardView /></Shell>;
  else if (lobbyView === 'friends') body = <Shell><FriendsView /></Shell>;
  else if (lobbyView === 'shop') body = <Shell><ShopView /></Shell>;
  else if (lobbyView === 'rewards') body = <Shell><RewardsView /></Shell>;
  else if (lobbyView === 'support') body = <Shell bare><SupportView /></Shell>;
  else if (lobbyView === 'vip') body = <Shell><VipView /></Shell>;
  else if (lobbyView === 'clubs') body = <Shell><ClubsView /></Shell>;
  else if (lobbyView === 'tournaments') body = <Shell><TournamentsView /></Shell>;
  else body = <Shell><LobbyView /></Shell>;

  return (
    <ErrorBoundary>
      <Background />
      <Suspense fallback={<Splash text={t('app.loading')} />}>{body}</Suspense>
      {/* Phones/tablets are landscape-only: held PORTRAIT, this overlay blocks the whole app with a
          "rotate your phone" prompt; turned landscape, the app renders natively. Desktops render normally. */}
      {forceRotate && <RotateOverlay />}
      {status === 'authed' && <InviteBanner />}
      {status === 'authed' && <ClubInviteBanner />}
      {/* First-run welcome takes precedence; the install prompt waits until it's done. */}
      {status === 'authed' && !room && !spectating && !onboarded && <OnboardingModal />}
      {status === 'authed' && !room && !spectating && onboarded && <InstallModal />}
      {status === 'authed' && !room && !spectating && onboarded && <DailyStreakModal />}
      {status === 'authed' && <RulesModal />}
      {status === 'authed' && <RankedSearchOverlay />}
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
      <CookieNotice />
    </ErrorBoundary>
  );
}
