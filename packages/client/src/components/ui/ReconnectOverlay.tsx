import { useGameStore } from '../../store/gameStore.ts';
import { useAuthStore } from '../../store/authStore.ts';
import { useT } from '../../lib/i18n.ts';

/**
 * Transient "Po rilidhem…" banner shown while the Socket.IO connection is down but
 * the player is still signed in — instead of silently dropping them. Socket.IO keeps
 * retrying; on reconnect the server pushes fresh state (the table/lobby is restored)
 * and `connected` flips back true, hiding this.
 *
 * Deliberately NON-blocking: a slim top banner (not a full-screen scrim) so it never
 * permanently covers the table during a brief blip. It clears the moment the socket
 * reconnects. We require a connection to have existed (`socket` set) so it doesn't
 * flash during the very first connect handshake.
 */
export function ReconnectOverlay() {
  const t = useT();
  const status = useAuthStore((s) => s.status);
  const connected = useGameStore((s) => s.connected);
  const socket = useGameStore((s) => s.socket);
  const inRoom = useGameStore((s) => s.room != null);

  if (status !== 'authed' || connected || !socket) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-[70] flex justify-center pointer-events-none"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
      role="status"
      aria-live="polite"
    >
      <div className="panel-solid pointer-events-auto flex items-center gap-2.5 px-4 py-2 animate-rise shadow-lg">
        <span
          className="inline-block w-3.5 h-3.5 rounded-full border-2 border-gold-hi/30 border-t-gold-hi animate-spin shrink-0"
          aria-hidden
        />
        <span className="font-display font-semibold tracking-wide text-sm text-gold-hi">
          {t('reconnect.reconnecting')}
        </span>
        {/* Only mention the saved game when actually at a table. */}
        {inRoom && <span className="text-xs text-muted hidden sm:inline">· {t('reconnect.savingState')}</span>}
      </div>
    </div>
  );
}
