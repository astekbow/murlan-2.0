import { useGameStore } from '../../store/gameStore.ts';

/** Shown while the socket is down but the player is still seated in a room — the
 *  server pushes a fresh full state on reconnect (so the table is restored). */
export function ReconnectOverlay() {
  const connected = useGameStore((s) => s.connected);
  const room = useGameStore((s) => s.room);
  if (connected || !room) return null;

  return (
    <div className="fixed inset-0 z-[65] grid place-items-center bg-black/70 p-4">
      <div className="panel-solid p-7 text-center animate-pop">
        <div className="text-4xl mb-3 animate-twinkle">📡</div>
        <div className="gold-text font-display font-semibold tracking-wide text-xl">Po rilidhemi…</div>
        <div className="text-sm text-muted mt-1">Po e ruajmë gjendjen e lojës.</div>
      </div>
    </div>
  );
}
