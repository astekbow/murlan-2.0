// Full-screen "searching for opponents" overlay shown while the player is in the
// ranked matchmaking queue. Disappears automatically once a match is found (the
// server seats the player into a room → gameStore clears `queue` + sets `room`).
import type { MatchType } from '@murlan/shared';
import { useGameStore } from '../../store/gameStore.ts';

const TYPE_LABEL: Record<MatchType, string> = {
  '1v1': '1 kundër 1',
  '1v1v1': '1v1v1',
  '2v2': '2 kundër 2',
};

export function RankedSearchOverlay() {
  const queue = useGameStore((s) => s.queue);
  const room = useGameStore((s) => s.room);
  const cancelRanked = useGameStore((s) => s.cancelRanked);
  if (!queue || room) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 backdrop-blur-sm">
      <div className="panel p-8 text-center max-w-sm mx-4 animate-pop">
        <div className="text-5xl mb-3 animate-pulse">⚔️</div>
        <h2 className="font-display font-bold text-xl gold-text tracking-wide">PO KËRKOJMË KUNDËRSHTARË</h2>
        <p className="text-sm text-muted mt-2">Ndeshje ranked · {TYPE_LABEL[queue.matchType]}</p>
        <div className="mt-4 flex items-center justify-center gap-1.5">
          {Array.from({ length: Math.max(queue.needed, 1) }).map((_, i) => (
            <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < queue.size ? 'bg-gold' : 'bg-white/15'}`} />
          ))}
        </div>
        <p className="text-xs text-muted mt-2">{queue.size} / {queue.needed} lojtarë</p>
        <button onClick={cancelRanked} className="btn btn-ghost mt-5">Anulo</button>
      </div>
    </div>
  );
}
