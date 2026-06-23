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
  // Oldest first → current last (rendered on top). Keep only the current play + the 2
  // previous ones; older plays drop off so the centre stays tidy.
  const layers = [...history, ...(pile ? [pile] : [])].slice(-3);

  if (layers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 text-cream/75 text-center">
        <div className="font-display text-[11px] uppercase tracking-[0.3em] opacity-70">{t('pile.tableLabel')}</div>
        <div className="text-sm italic opacity-60">{t('pile.emptyNewRound')}</div>
      </div>
    );
  }

  const top = layers.length - 1;
  return (
    <div className="flex flex-col items-center gap-2">
      {/* Stack layers: each earlier play is offset up-left and dimmed; the newest sits
          front-and-centre at full opacity. The first layer is in-flow (sizes the box);
          the rest are absolutely positioned relative to it. */}
      <div className="relative grid place-items-center">
        {layers.map((combo, i) => {
          const back = top - i; // 0 = newest (front), higher = older (further back)
          const isTop = i === top;
          const cards = sortComboForDisplay(combo);
          // Key by CONTENT (the cards), not the array index: when a new play shifts the stack,
          // each existing layer keeps its identity → it does NOT remount → it does NOT replay the
          // play animation. Only the genuinely-new top layer (`is-new`) animates. Cards are unique
          // within a game, so these keys never collide.
          const layerKey = cards.map(cardKey).join('-');
          return (
            <div
              key={layerKey}
              // All layers share ONE grid cell and are centred (place-items-center on the parent),
              // so EVERY play — whatever its width — lands dead-centre; only `back` nudges the older
              // ones up-left. (Before, the box was sized by the OLDEST layer and the new play was
              // inset to it, so a wider/narrower play drifted to the side before recentring.)
              className={`pile-cards${isTop ? ' is-new' : ''}`}
              style={{
                gridArea: '1 / 1',
                transform: `translate(${-back * 11}px, ${-back * 13}px)`,
                opacity: isTop ? 1 : 0.5, // older plays just dimmed (no blur), as before
                zIndex: i + 1,
              }}
            >
              {cards.map((card) => (
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
