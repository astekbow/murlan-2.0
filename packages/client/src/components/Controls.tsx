import { useState } from 'react';
import type { Card, Combo } from '@murlan/engine';
import { evaluateSelection } from '../lib/selection.ts';
import { useT } from '../lib/i18n.ts';

const COMBO_LABEL_KEY: Record<Combo['type'], string> = {
  single: 'controls.comboSingle',
  pair: 'controls.comboPair',
  triple: 'controls.comboTriple',
  bomb: 'controls.comboBomb',
  kolor: 'controls.comboKolor',
  flush: 'controls.comboFlush',
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
  const t = useT();
  const evalResult = evaluateSelection(selectedCards, pile);
  const openingOk = !requireThreeSpades || selectedCards.some(isThreeSpades);
  // Brief in-flight guard so a double-tap can't fire two actions (the second
  // would race the authoritative state and pop a spurious "illegal move" toast).
  // 400ms: long enough to swallow an accidental double-tap, short enough that the
  // button doesn't feel laggy/stuck (the owner saw the old 900ms as "lag" on Pas).
  const [submitting, setSubmitting] = useState(false);
  const guard = (fn: () => void) => {
    if (submitting) return;
    setSubmitting(true);
    fn();
    window.setTimeout(() => setSubmitting(false), 400);
  };
  const playable = isMyTurn && evalResult.ok && openingOk && !submitting;

  let hint = '';
  if (!isMyTurn) hint = t('controls.waitTurn');
  else if (selectedCards.length === 0) hint = t('controls.pickCards');
  else if (requireThreeSpades && !openingOk) hint = t('controls.openingThreeSpades');
  else if (evalResult.ok && evalResult.combo) hint = t('controls.ready', { combo: t(COMBO_LABEL_KEY[evalResult.combo.type]) });
  else if (evalResult.reason) hint = evalResult.reason;

  return (
    <div className="ctrl-wrap flex flex-col items-center gap-2.5 px-3 pb-4">
      <div className={`ctrl-hint text-xs h-4 ${playable ? 'text-gold-hi' : 'text-muted'}`}>{hint}</div>
      <div className="ctrl-row flex gap-3 w-full max-w-sm">
        <button type="button" onClick={onClear} disabled={selectedCards.length === 0} className="ctrl-clear btn btn-ghost">
          {t('controls.clear')}
        </button>
        <button type="button" onClick={() => guard(onPass)} disabled={!isMyTurn || !canPass || submitting} className="ctrl-pass btn btn-ghost flex-1">
          {t('controls.pass')}
        </button>
        <button type="button" onClick={() => guard(onPlay)} disabled={!playable} className="ctrl-play btn btn-gold flex-1 btn-lg">
          {t('controls.play')}
        </button>
      </div>
    </div>
  );
}
