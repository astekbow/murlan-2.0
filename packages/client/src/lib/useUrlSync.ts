import { useEffect } from 'react';
import { useUiStore, type LobbyView } from '../store/uiStore.ts';

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

/** Keeps the lobby sub-view (`uiStore.view`) in sync with the URL path, giving:
 *  deep-linkable + refreshable sub-pages (/wallet, /leaderboard, …), and a working
 *  browser / Android **back** button between pages. It deliberately does NOT touch the
 *  auth / room / table / replay flows — those override the lobby view in App, and the
 *  path simply stays at whatever the last lobby view was. */
export function useUrlSync(): void {
  // Adopt the view from the current path on load (e.g. a refresh / deep link on
  // /wallet), and follow back/forward navigation.
  useEffect(() => {
    const initial = viewForPath(window.location.pathname);
    if (initial !== 'lobby') useUiStore.getState().setView(initial);

    const onPop = () => useUiStore.getState().setView(viewForPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Push a history entry whenever the view changes (so back returns to the previous
  // page). The path-equality guard stops the popstate → setView → push loop.
  useEffect(() => {
    return useUiStore.subscribe((state, prev) => {
      if (state.view === prev.view) return;
      const path = VIEW_PATH[state.view];
      if (window.location.pathname !== path) window.history.pushState({}, '', path);
    });
  }, []);
}
