import { useState } from 'react';
import type { Card, Combo } from '@murlan/engine';
import { evaluateSelection } from '../lib/selection.ts';

const COMBO_LABEL: Record<Combo['type'], string> = {
  single: 'letër e vetme',
  pair: 'çift',
  triple: 'treshe',
  bomb: 'bombë',
  kolor: 'kolor',
  flush: 'ngjyrë',
};

interface ControlsProps {
  selectedCards: Card[];
  pile: Combo | null;
  isMyTurn: boolean;
  canPass: boolean; // false when leading (no pile to beat)
  requireThreeSpades?: boolean; // first game opening must include 3♠
  onPlay: () => void;
  onPass: () => void;
  onClear: () => void;
}

const isThreeSpades = (c: Card) => c.kind === 'standard' && c.rank === '3' && c.suit === 'S';

/** Play / Pass with instant client-side validation feedback (engine-backed). */
export function Controls({ selectedCards, pile, isMyTurn, canPass, requireThreeSpades, onPlay, onPass, onClear }: ControlsProps) {
  const evalResult = evaluateSelection(selectedCards, pile);
  const openingOk = !requireThreeSpades || selectedCards.some(isThreeSpades);
  // Brief in-flight guard so a double-tap can't fire two actions (the second
  // would race the authoritative state and pop a spurious "illegal move" toast).
  // Re-enables shortly after, so a rejected move can still be retried.
  const [submitting, setSubmitting] = useState(false);
  const guard = (fn: () => void) => {
    if (submitting) return;
    setSubmitting(true);
    fn();
    window.setTimeout(() => setSubmitting(false), 900);
  };
  const playable = isMyTurn && evalResult.ok && openingOk && !submitting;

  let hint = '';
  if (!isMyTurn) hint = 'Prit radhën tënde…';
  else if (selectedCards.length === 0) hint = 'Zgjidh letra për të luajtur.';
  else if (requireThreeSpades && !openingOk) hint = 'Hapja e parë duhet të përmbajë 3♠.';
  else if (evalResult.ok && evalResult.combo) hint = `Gati: ${COMBO_LABEL[evalResult.combo.type]}.`;
  else if (evalResult.reason) hint = evalResult.reason;

  return (
    <div className="flex flex-col items-center gap-2.5 px-3 pb-4">
      <div className={`text-xs h-4 ${playable ? 'text-gold-hi' : 'text-muted'}`}>{hint}</div>
      <div className="flex gap-3 w-full max-w-sm">
        <button type="button" onClick={onClear} disabled={selectedCards.length === 0} className="btn btn-ghost">
          Pastro
        </button>
        <button type="button" onClick={() => guard(onPass)} disabled={!isMyTurn || !canPass || submitting} className="btn btn-ghost flex-1">
          Pas
        </button>
        <button type="button" onClick={() => guard(onPlay)} disabled={!playable} className="btn btn-gold flex-1 btn-lg">
          Luaj
        </button>
      </div>
    </div>
  );
}
