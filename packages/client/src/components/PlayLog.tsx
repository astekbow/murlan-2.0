import { memo } from 'react';
import type { LogEntry } from '../store/gameStore.ts';

/** A small scrolling log of recent table events. */
function PlayLogImpl({ entries }: { entries: LogEntry[] }) {
  const recent = entries.slice(-6);
  return (
    <div className="rounded-lg bg-slate-900/70 backdrop-blur px-3 py-2 text-[11px] text-slate-300 h-24 overflow-y-auto no-scrollbar">
      {recent.length === 0 ? (
        <div className="italic opacity-60">Ende pa ngjarje.</div>
      ) : (
        <ul className="space-y-0.5">
          {recent.map((e) => (
            <li key={e.id}>• {e.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
// Memoized: only re-renders when `entries` changes (not on every unrelated table update).
export const PlayLog = memo(PlayLogImpl);
