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

let pendingJoinCode: string | null = null;
let pendingProfileId: string | null = null;
(() => {
  const path = readPath();
  const join = /^\/join\/([A-Za-z0-9]{4,12})\/?$/.exec(path);
  if (join) {
    window.history.replaceState({}, '', '/'); // clean → a refresh won't re-join
    pendingJoinCode = join[1]!.toUpperCase();
    return;
  }
  const prof = /^\/u\/([A-Za-z0-9_-]{1,40})\/?$/.exec(path);
  if (prof) {
    window.history.replaceState({}, '', '/'); // clean → the modal opens once, not on refresh
    pendingProfileId = prof[1]!;
    return;
  }
  const tourn = /^\/t\/[A-Za-z0-9_-]+\/?$/.exec(path);
  if (tourn) {
    window.history.replaceState({}, '', '/tournaments'); // useUrlSync adopts this view
  }
})();

/** Returns a pending private-room join code exactly once (null thereafter). */
export function takePendingJoinCode(): string | null {
  const c = pendingJoinCode;
  pendingJoinCode = null;
  return c;
}

/** Returns a pending /u/<id> profile to open exactly once (null thereafter). */
export function takePendingProfileId(): string | null {
  const id = pendingProfileId;
  pendingProfileId = null;
  return id;
}

/** Build a shareable absolute invite link for a private room's join code. */
export function roomInviteLink(code: string): string {
  try { return `${window.location.origin}/join/${code}`; } catch { return `/join/${code}`; }
}
