import { useEffect } from 'react';
import { useUiStore, type LobbyView } from '../store/uiStore.ts';
import { useGameStore } from '../store/gameStore.ts';

// One path per lobby sub-view. '/' is the lobby home.
const VIEW_PATH: Record<LobbyView, string> = {
  lobby: '/',
  wallet: '/wallet',
  shop: '/shop',
  leaderboard: '/leaderboard',
  friends: '/friends',
  rewards: '/rewards',
  support: '/support',
  vip: '/vip',
  clubs: '/clubs',
  tournaments: '/tournaments',
  admin: '/admin',
};
const PATH_VIEW = Object.fromEntries(
  Object.entries(VIEW_PATH).map(([v, p]) => [p, v]),
) as Record<string, LobbyView>;

function viewForPath(path: string): LobbyView {
  return PATH_VIEW[path] ?? 'lobby';
}

/** The URL path that represents the CURRENT app state. We route the two SAFE, deep-linkable states —
 *  a provably-fair REPLAY (`/replay/:matchId`, no socket) and SPECTATING a live match (`/watch/:roomId`,
 *  read-only, no leave-guard). An active ROOM/TABLE is deliberately NOT routed: its back button is owned
 *  by the leave-guard (useExitGuard) and private rooms already share via `/join/<code>`. */
function statePath(): string {
  const ui = useUiStore.getState();
  const g = useGameStore.getState();
  if (ui.replayMatchId) return `/replay/${ui.replayMatchId}`;
  if (g.spectating && g.room) return `/watch/${g.room.id}`;
  return VIEW_PATH[ui.view];
}

/** Keeps the URL in sync with the app state (lobby sub-views + replay + spectate), giving deep-linkable,
 *  refreshable pages and a working browser / Android **back** button. `/watch/:id` on a fresh load is
 *  resumed once the socket connects (see App.tsx, mirrors the /join/<code> handler). */
export function useUrlSync(): void {
  // state -> URL: push a history entry whenever the routed state changes.
  useEffect(() => {
    const sync = () => {
      const path = statePath();
      if (window.location.pathname !== path) window.history.pushState({}, '', path);
    };
    const unsubUi = useUiStore.subscribe((s, p) => { if (s.view !== p.view || s.replayMatchId !== p.replayMatchId) sync(); });
    const unsubGame = useGameStore.subscribe((s, p) => { if (s.spectating !== p.spectating || s.room !== p.room) sync(); });
    return () => { unsubUi(); unsubGame(); };
  }, []);

  // URL -> state on load + back/forward. Replay opens immediately (no sign-in needed); a `/watch/:id`
  // load is picked up by App once connected. Backing out of a replay/spectate tidies up + adopts the view.
  useEffect(() => {
    const apply = () => {
      const path = window.location.pathname;
      const ui = useUiStore.getState();
      const g = useGameStore.getState();
      const replay = /^\/replay\/(.+)$/.exec(path);
      // Legacy alias: ?replay=<id> (older shared links) → adopt it as the /replay/<id> route.
      const legacyReplay = new URLSearchParams(window.location.search).get('replay');
      if (replay || legacyReplay) {
        const id = replay ? decodeURIComponent(replay[1]) : legacyReplay!;
        if (ui.replayMatchId !== id) ui.openReplay(id);
        return;
      }
      if (ui.replayMatchId) ui.closeReplay();
      // On /watch/:id keep spectating (App resumes it); leaving the /watch path stops the spectate.
      if (/^\/watch\//.test(path)) return;
      if (g.spectating) g.stopSpectate();
      ui.setView(viewForPath(path));
    };
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, []);
}
