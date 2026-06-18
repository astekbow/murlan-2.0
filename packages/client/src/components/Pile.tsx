import { memo } from 'react';
import type { Combo } from '@murlan/engine';
import { CardView } from './CardView.tsx';
import { cardKey, sortComboForDisplay } from '../lib/cards.ts';
import { useT } from '../lib/i18n.ts';

const COMBO_LABEL_KEY: Record<Combo['type'], string> = {
  single: 'pile.comboSingle',
  pair: 'pile.comboPair',
  triple: 'pile.comboTriple',
  bomb: 'pile.comboBomb',
  kolor: 'pile.comboKolor',
  flush: 'pile.comboFlush',
};

/** The current trick in the centre of the table. Plays already beaten stay on the felt
 *  (`history`, oldest first) with the current play (`pile`) overlaid on top, so the table
 *  shows the whole trick instead of cards vanishing on every play. */
function PileImpl({ pile, history = [] }: { pile: Combo | null; history?: Combo[] }) {
  const t = useT();
  // Oldest first → current last (rendered on top). Cap the visible depth so the stack
  // never grows unwieldy in a long trick.
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
  return (
    <div className="flex flex-col items-center gap-2">
      {pile && (
        <div
          className="relative z-10 font-display text-[13px] font-bold uppercase tracking-wide text-gold-hi rounded px-1.5 py-0.5"
          style={{ textShadow: '0 2px 4px rgba(0,0,0,0.5)', background: 'rgba(0,0,0,0.4)' }}
        >{t(COMBO_LABEL_KEY[pile.type])}</div>
      )}
      {/* Stack layers: each earlier play is offset up-left and dimmed; the newest sits
          front-and-centre at full opacity. The first layer is in-flow (sizes the box);
          the rest are absolutely positioned relative to it. */}
      <div className="relative">
        {layers.map((combo, i) => {
          const back = top - i; // 0 = newest (front), higher = older (further back)
          const isTop = i === top;
          return (
            <div
              key={i}
              className={`pile-cards${i === 0 ? '' : ' absolute inset-0'}${isTop ? ' animate-pop' : ''}`}
              style={{
                transform: `translate(${-back * 11}px, ${-back * 13}px)`,
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
