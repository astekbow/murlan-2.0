import type { Combo } from '@murlan/engine';
import { CardView } from './CardView.tsx';
import { cardKey } from '../lib/cards.ts';

const COMBO_LABEL: Record<Combo['type'], string> = {
  single: 'Letër e vetme',
  pair: 'Çift',
  triple: 'Treshe',
  bomb: 'Bombë',
  kolor: 'Kolor',
  flush: 'Ngjyrë (flush)',
};

/** The current pile in the centre of the table — overlapping face-up cards. */
export function Pile({ pile }: { pile: Combo | null }) {
  if (!pile) {
    return (
      <div className="flex flex-col items-center gap-1 text-cream/75 text-center">
        <div className="font-display text-[11px] uppercase tracking-[0.3em] opacity-70">Tavolina</div>
        <div className="text-sm italic opacity-60">Pa letra — radhë e re</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 animate-pop">
      <div className="font-display text-[11px] uppercase tracking-wide text-gold-hi/90">{COMBO_LABEL[pile.type]}</div>
      <div className="pile-cards">
        {pile.cards.map((card) => (
          <CardView key={cardKey(card)} card={card} />
        ))}
      </div>
    </div>
  );
}
