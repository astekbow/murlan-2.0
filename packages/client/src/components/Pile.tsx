import { memo } from 'react';
import type { Combo } from '@murlan/engine';
import { CardView } from './CardView.tsx';
import { cardKey, sortComboForDisplay } from '../lib/cards.ts';
import { useT } from '../lib/i18n.ts';

/** The current trick in the centre of the table. Plays already beaten stay on the felt
 *  (`history`, oldest first) with the current play (`pile`) overlaid on top, so the table
 *  shows the whole trick instead of cards vanishing on every play. */
function PileImpl({ pile, history = [] }: { pile: Combo | null; history?: Combo[] }) {
  const t = useT();
  // Oldest first → current last (rendered on top). Cap the visible depth so the stack never
  // grows unwieldy. (Landscape keeps the stack inside the betting ring via a small, canvas-
  // relative per-layer offset — see --pile-step-* in the .tv-ls scope — so 6 layers stay tight;
  // portrait behaviour is unchanged.)
  const layers = [...history, ...(pile ? [pile] : [])].slice(-6);

  if (layers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 text-cream/75 text-center">
        <div className="font-display text-[11px] uppercase tracking-[0.3em] opacity-70">{t('pile.tableLabel')}</div>
        <div className="text-sm italic opacity-60">{t('pile.emptyNewRound')}</div>
      </div>
    );
  }

  const top = layers.length - 1;
  // Key each layer by its CONTENT (joined card ids) — NOT the array index. As slice(-N) shifts
  // the window on a new play, a settled history layer keeps the same key, so it does NOT remount
  // and does NOT re-run the entrance animation. Only the genuinely new top layer mounts fresh.
  const keyFor = (combo: Combo) => combo.cards.map(cardKey).join('|');
  return (
    <div className="flex flex-col items-center gap-2">
      {/* Stack layers: each earlier play is offset up-left and dimmed; the newest sits
          front-and-centre at full opacity. The first layer is in-flow (sizes the box);
          the rest are absolutely positioned relative to it. Per-layer offset is expressed
          relative to the canvas (--pile-step, set in the .tv-ls scope; small px fallback)
          so the stack scales with the table instead of fixed px. */}
      <div className="relative">
        {layers.map((combo, i) => {
          const back = top - i; // 0 = newest (front), higher = older (further back)
          const isTop = i === top;
          return (
            <div
              key={keyFor(combo)}
              // Only the new TOP layer gets `is-new` → `throwin` is scoped to it, so settled
              // history cards never lurch back into motion (no double-entrance: animate-pop is
              // gone; throwin alone carries the entrance).
              className={`pile-cards${i === 0 ? '' : ' absolute inset-0'}${isTop ? ' is-new' : ''}`}
              style={{
                // Portrait fallback = the original 11/13px (unchanged); landscape overrides
                // --pile-step-* with small canvas-relative cqw so the stack stays inside the ring.
                transform: `translate(calc(var(--pile-step-x, 11px) * ${-back}), calc(var(--pile-step-y, 13px) * ${-back}))`,
                opacity: isTop ? 1 : 0.5,
                zIndex: i + 1,
              }}
            >
              {sortComboForDisplay(combo).map((card) => (
                <CardView key={cardKey(card)} card={card} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Memoized: the centre pile only re-renders when the pile or its history changes, not on
// every hand/seat/timer update.
export const Pile = memo(PileImpl);
