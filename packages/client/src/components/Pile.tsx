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

/** The current pile in the centre of the table — overlapping face-up cards. */
function PileImpl({ pile }: { pile: Combo | null }) {
  const t = useT();
  if (!pile) {
    return (
      <div className="flex flex-col items-center gap-1 text-cream/75 text-center">
        <div className="font-display text-[11px] uppercase tracking-[0.3em] opacity-70">{t('pile.tableLabel')}</div>
        <div className="text-sm italic opacity-60">{t('pile.emptyNewRound')}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 animate-pop">
      <div className="font-display text-[11px] uppercase tracking-wide text-gold-hi/90">{t(COMBO_LABEL_KEY[pile.type])}</div>
      <div className="pile-cards">
        {sortComboForDisplay(pile).map((card) => (
          <CardView key={cardKey(card)} card={card} />
        ))}
      </div>
    </div>
  );
}

// Memoized: the centre pile only re-renders when the pile itself changes, not on
// every hand/seat/timer update.
export const Pile = memo(PileImpl);
