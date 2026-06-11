import type { ReactNode } from 'react';

/** Re-keys its subtree whenever `viewKey` changes so the CSS `.view-enter`
 *  animation re-runs — a lightweight fade/slide between lobby pages. No library;
 *  honors prefers-reduced-motion (the universal rule neutralizes the animation). */
export function ViewTransition({ viewKey, children }: { viewKey: string; children: ReactNode }) {
  return (
    <div key={viewKey} className="view-enter">
      {children}
    </div>
  );
}
