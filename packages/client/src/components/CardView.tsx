import { memo, type CSSProperties } from 'react';
import type { Card } from '@murlan/engine';
import { isRed, rankText, suitSymbol } from '../lib/cards.ts';

interface CardViewProps {
  card: Card;
  selected?: boolean;
  small?: boolean;
  big?: boolean;
  onClick?: () => void;
  dealDelayMs?: number;
  style?: CSSProperties;
  /** Pure display — render a non-interactive, aria-hidden element. Used inside Hand, where the WRAPPING
   *  element is the labelled toggle button, so the card itself must NOT be a second nested button. */
  decorative?: boolean;
}

/** A single face-up playing card (cream face, gold ring when selected). */
function CardViewImpl({ card, selected, small, big, onClick, dealDelayMs, style, decorative }: CardViewProps) {
  const red = isRed(card);
  const size = small ? 'sm' : big ? 'lg' : '';
  const mergedStyle: CSSProperties = {
    ...style,
    ...(dealDelayMs !== undefined ? { animation: 'cardfade .35s ease both', animationDelay: `${dealDelayMs}ms` } : {}),
  };
  const cls = ['gcard', size, red ? 'red' : '', card.kind === 'joker' ? 'joker' : '', selected ? 'sel' : '', onClick && !decorative ? 'active:scale-95' : ''].join(' ');
  const faces = (
    <>
      <span className="gc-r">{rankText(card)}</span>
      <span className="gc-s">{suitSymbol(card)}</span>
      <span className="gc-big">{suitSymbol(card)}</span>
      <span className="gc-br">{rankText(card)}</span>
    </>
  );
  if (decorative) {
    return <div aria-hidden="true" style={mergedStyle} className={cls}>{faces}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={selected}
      aria-label={`${rankText(card)} ${suitSymbol(card)}`}
      style={mergedStyle}
      className={cls}
    >
      {faces}
    </button>
  );
}
/** Memoized: a card re-renders only when ITS OWN props change, not on every parent update. */
export const CardView = memo(CardViewImpl);

/** A face-down card (maroon club back). */
function CardBackImpl({ small }: { small?: boolean }) {
  const size = small ? 'w-6 h-9' : 'w-9 h-[52px]';
  return (
    <div
      className={`${size} rounded-md`}
      style={{
        background: 'repeating-linear-gradient(45deg,#8f2620 0 4px,#a23029 4px 8px)',
        boxShadow: '0 4px 8px -3px #000, inset 0 0 0 1.5px #f1deae, inset 0 0 0 2px #8f2620',
      }}
      aria-hidden
    />
  );
}
export const CardBack = memo(CardBackImpl);
