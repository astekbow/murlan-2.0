import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { Card } from '@murlan/engine';
import { singlePower } from '@murlan/engine';
import { CardView } from './CardView.tsx';
import { cardKey, cardAriaLabel } from '../lib/cards.ts';

interface HandProps {
  cards: Card[];
  selected: string[];
  onToggle: (id: string) => void;
  dealAnimate?: boolean;
  /** When set (e.g. during the card switch), cards NOT in this set are dimmed. */
  eligibleIds?: ReadonlySet<string> | null;
  /**
   * Landscape canvas mode: size the whole fan to ALWAYS fit the measured zone
   * width with NO horizontal scroll, keeping the cards as big as possible. When
   * unset, the original (portrait/desktop) fitting behaviour is used unchanged.
   */
  fit?: boolean;
}

/** Weakest→strongest by Murlan power (3…10,J,Q,K,A,2, black joker, red joker). */
const sortIds = (cards: Card[]): string[] =>
  [...cards].sort((a, b) => singlePower(a) - singlePower(b)).map(cardKey);

/**
 * The local player's hand: shown as a fan, auto-sorted weakest→strongest by
 * default, and freely RE-ORDERABLE by drag (pointer = mouse + touch). A short
 * press toggles selection; a drag moves the card. The fan width is fitted to the
 * available space so EVERY card is visible (it never overflows off-screen).
 * Display/order only — moves are sent to the server by card id.
 */
// Memoized: with a stable onToggle (TableView useCallbacks it) the hand skips
// re-rendering on unrelated table updates (an opponent's move, a timer tick) — it
// only re-renders when the cards/selection/eligibility actually change.
export const Hand = memo(function Hand({ cards, selected, onToggle, eligibleIds, fit }: HandProps) {
  const byId = new Map(cards.map((c) => [cardKey(c), c] as const));
  const selectedSet = new Set(selected);

  const [order, setOrder] = useState<string[]>(() => sortIds(cards));
  // Reconcile on hand change: keep the manual order for surviving cards, but
  // re-sort fully whenever new cards arrive (a fresh deal or a received card).
  useEffect(() => {
    setOrder((prev) => {
      const present = new Set(cards.map(cardKey));
      const survivors = prev.filter((id) => present.has(id));
      const hasNew = cards.some((c) => !prev.includes(cardKey(c)));
      return hasNew || survivors.length === 0 ? sortIds(cards) : survivors;
    });
  }, [cards]);

  const ids = order.filter((id) => byId.has(id));
  const n = ids.length;

  // Fit the fan to the available width so all cards stay on-screen.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(0);
  // useLayoutEffect (not useEffect): measure + set the width BEFORE the browser paints,
  // so the cards render at their final size immediately — no "start small then grow" flash.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = availW || 340;
  let CARD_W: number;
  let step: number;
  if (fit) {
    // LANDSCAPE CANVAS: cards are THINNER + TALLER than a normal card (ratio set below) —
    // a narrow card overlaps less, so the visible left sliver is wider and the FULL rank
    // (incl. "10") shows; the extra height keeps them looking big. Constant size (no
    // grow/shrink with count); the step (overlap) adapts so the fan never scrolls.
    CARD_W = Math.min(w < 520 ? 96 : 116, Math.floor(w * 0.86));
    const maxStep = Math.round(CARD_W * 0.86);
    step = n > 1 ? Math.min(maxStep, (w - CARD_W) / (n - 1)) : 0;
  } else {
    // PORTRAIT / DESKTOP — original behaviour, unchanged.
    // BIG, readable cards. `step` overlaps them to fit the width (no scroll); maxStep gives
    // a little extra breathing room between cards on screens that have room, and min-step
    // keeps a few px of gap even on a full hand.
    CARD_W = w < 420 ? 98 : 112;
    const maxStep = Math.round(CARD_W * 0.72); // more spread on screens with room
    // min step ≈ enough that each card's rank+suit corner clears the next card (the suit was
    // getting half-covered when too tight). Cards stay big; the fan scrolls only if a full
    // hand truly can't fit at this spacing.
    step = n > 1 ? Math.max(27, Math.min(maxStep, (w - CARD_W - 8) / (n - 1))) : 0;
  }
  // Landscape cards are taller+thinner (1.66) so a narrow card still reads as big; portrait keeps 1.4.
  const CARD_H = Math.round(CARD_W * (fit ? 1.66 : 1.4));
  const stageW = (n - 1) * step + CARD_W;

  const [drag, setDrag] = useState<{ id: string; x: number; moved: boolean } | null>(null);
  const startX = useRef(0);

  const onDown = (id: string, e: PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    startX.current = e.clientX;
    setDrag({ id, x: e.clientX, moved: false });
  };
  const onMove = (id: string, e: PointerEvent) => {
    if (!drag || drag.id !== id) return;
    const moved = drag.moved || Math.abs(e.clientX - startX.current) > 6;
    const stage = stageRef.current?.getBoundingClientRect();
    if (stage && step > 0) {
      const target = Math.max(0, Math.min(n - 1, Math.round((e.clientX - stage.left - CARD_W / 2) / step)));
      setOrder((prev) => {
        const arr = prev.filter((x) => byId.has(x));
        const from = arr.indexOf(id);
        if (from === -1 || from === target) return prev;
        arr.splice(from, 1);
        arr.splice(target, 0, id);
        return arr;
      });
    }
    if (moved !== drag.moved || e.clientX !== drag.x) setDrag({ id, x: e.clientX, moved });
  };
  const onUp = (id: string, e: PointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (drag && drag.id === id && !drag.moved) onToggle(id);
    setDrag(null);
  };

  // Empty hand → render nothing (no "you have no cards" placeholder); keep the row's
  // height reserved so the layout doesn't jump when the deal arrives. In fit (canvas)
  // mode the zone already reserves height, so just measure-mount an empty ref.
  if (n === 0) {
    return fit
      ? <div ref={scrollRef} className="w-full flex-1 min-h-0" aria-hidden />
      : <div className="min-h-[124px]" aria-hidden />;
  }

  return (
    <div
      ref={scrollRef}
      className={fit
        ? 'no-scrollbar w-full flex-1 min-h-0 flex items-end justify-center'
        : 'no-scrollbar overflow-x-auto overflow-y-visible max-w-full px-2'}
      style={fit ? { overflowX: 'clip', overflowY: 'visible' } : undefined}
    >
      <div ref={stageRef} className="hand-stage" style={{ width: stageW, height: CARD_H + 34 }}>
        {ids.map((id, i) => {
          const card = byId.get(id);
          if (!card) return null;
          const isSel = selectedSet.has(id);
          const dragging = drag?.id === id;
          let style: CSSProperties;
          if (dragging) {
            const stage = stageRef.current?.getBoundingClientRect();
            const left = stage ? drag!.x - stage.left - CARD_W / 2 : i * step;
            // Straight row; a small lift while dragging so it reads as "picked up".
            style = { left, bottom: 0, transform: 'translateY(-16px)', zIndex: 50, transition: 'none' };
          } else {
            // Flat row. A selected card rises BUT keeps its natural stacking (z = i,
            // not on top of everything), so only its raised top edge (rank + gold ring)
            // peeks above the row — it never covers the neighbouring cards. The lift +
            // gold ring alone signal the pick (no dimming of the other cards).
            style = { left: i * step, bottom: 0, transform: isSel ? 'translateY(calc(var(--card-lift, 32px) * -1))' : 'none', zIndex: i, transition: 'transform .12s ease' };
          }
          if (eligibleIds && !eligibleIds.has(id)) style = { ...style, opacity: 0.4 };
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id); }
          };
          return (
            <div
              key={id}
              className="hand-card"
              style={style}
              // Keyboard + screen-reader access: each card is a labelled toggle
              // button (pointer users also drag to reorder; keyboard users select).
              role="button"
              tabIndex={0}
              aria-label={cardAriaLabel(card)}
              aria-pressed={isSel}
              onKeyDown={onKey}
              onPointerDown={(e) => onDown(id, e)}
              onPointerMove={(e) => onMove(id, e)}
              onPointerUp={(e) => onUp(id, e)}
              onPointerCancel={() => setDrag(null)}
            >
              <CardView card={card} big selected={isSel} style={{ width: CARD_W, height: CARD_H, pointerEvents: 'none' }} />
            </div>
          );
        })}
      </div>
    </div>
  );
});
