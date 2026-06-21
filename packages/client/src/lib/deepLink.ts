// Shareable deep-links captured ONCE from the entry URL, before useUrlSync rewrites
// the path to a lobby view. Two kinds:
//   /join/<CODE>  → a private-room invite. The code is stashed and consumed by App
//                   once the player is authenticated + the socket is connected.
//   /t/<id>       → a tournament link. Rewritten to /tournaments so useUrlSync opens
//                   the tournaments view on load.
// The URL is cleaned immediately so a refresh / back doesn't re-trigger the action.

function readPath(): string {
  try { return window.location.pathname; } catch { return '/'; }
}

let pendingJoinCode: string | null = (() => {
  const path = readPath();
  const join = /^\/join\/([A-Za-z0-9]{4,12})\/?$/.exec(path);
  if (join) {
    window.history.replaceState({}, '', '/'); // clean → a refresh won't re-join
    return join[1]!.toUpperCase();
  }
  const tourn = /^\/t\/[A-Za-z0-9_-]+\/?$/.exec(path);
  if (tourn) {
    window.history.replaceState({}, '', '/tournaments'); // useUrlSync adopts this view
  }
  return null;
})();

/** Returns a pending private-room join code exactly once (null thereafter). */
export function takePendingJoinCode(): string | null {
  const c = pendingJoinCode;
  pendingJoinCode = null;
  return c;
}

/** Build a shareable absolute invite link for a private room's join code. */
export function roomInviteLink(code: string): string {
  try { return `${window.location.origin}/join/${code}`; } catch { return `/join/${code}`; }
}
