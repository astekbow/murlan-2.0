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
export const Hand = memo(function Hand({ cards, selected, onToggle, eligibleIds, dealAnimate, fit }: HandProps) {
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

  // Deal-in: stagger each card's entrance ONCE on a fresh deal (the hand going from empty
  // to a full set), never on reorder/selection (those keep the same cards). We snapshot the
  // sorted ids at deal time so the stagger index follows the dealt order, and clear the flag
  // after the animation window so a later re-render doesn't replay it.
  const prevCount = useRef(0);
  const dealtIdsRef = useRef<string[]>([]);
  const [deal, setDeal] = useState<{ key: number; active: boolean }>({ key: 0, active: false });
  useEffect(() => {
    const freshDeal = !!dealAnimate && prevCount.current === 0 && n > 0;
    prevCount.current = n;
    if (freshDeal) {
      dealtIdsRef.current = ids;
      // Bump the key (remounts the cards for a clean staggered entrance) AND mark active in
      // one update so the very first render after the deal already carries dealDelayMs.
      setDeal((d) => ({ key: d.key + 1, active: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, dealAnimate]);
  // Drop the stagger after the longest delay + the keyframe duration elapses so a later
  // re-render (reorder/selection) doesn't replay it. Keeps the card MOUNTED (key is stable).
  const dealKey = deal.key;
  const dealing = deal.active;
  useEffect(() => {
    if (!deal.active) return;
    const id = window.setTimeout(() => setDeal((d) => ({ ...d, active: false })), 700);
    return () => window.clearTimeout(id);
  }, [deal.active, deal.key]);

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
    // (incl. "10"/"JK") shows; the extra height keeps them looking big.
    CARD_W = Math.min(w < 520 ? 96 : 116, Math.floor(w * 0.86));
    const maxStep = Math.round(CARD_W * 0.86);
    // STEP FLOOR: the visible left sliver (= step) must never drop below what a 2-char rank
    // ("10"/"JK") needs in the top-left index band, or the trailing glyph hides under the next
    // card — the exact misread the thin-tall redesign was meant to kill. ~0.32·CARD_W clears
    // the index (left ~4cqw + the 2-glyph rank at ~20cqw).
    const minStep = Math.round(CARD_W * 0.32);
    if (n > 1) {
      const fitStep = (w - CARD_W) / (n - 1);
      if (fitStep >= minStep) {
        step = Math.min(maxStep, fitStep);
      } else {
        // A full hand can't honour the floor at this card size on a narrow canvas → shrink the
        // cards (keeping the tall ratio) just enough that the floor fits with NO scroll, instead
        // of overlapping below the "10"-safe sliver. Cards stay as big as the floor allows.
        step = minStep;
        CARD_W = Math.max(60, Math.floor(w - minStep * (n - 1)));
        step = Math.round(CARD_W * 0.32);
      }
    } else {
      step = 0;
    }
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
  // Landscape cards are taller+thinner (1.82) so a narrow card still reads as big; portrait keeps 1.4.
  const CARD_H = Math.round(CARD_W * (fit ? 1.82 : 1.4));
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
    // Touch slop: a finger always jitters a few px on a tap, so only treat it as a DRAG
    // (reorder) past 16px — below that it's a tap (select) and the card stays put. (Was 6px,
    // which made cards jump out of place on almost every tap.)
    const moved = drag.moved || Math.abs(e.clientX - startX.current) > 16;
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
            // Flat row. A selected card rises and is raised ABOVE its right neighbour (z = n+i)
            // so its lifted top edge (rank + gold ring) is never covered; unselected cards keep
            // natural stacking (z = i). `left` IS in the transition so neighbours GLIDE on a
            // drag-reorder instead of snapping.
            style = { left: i * step, bottom: 0, transform: isSel ? 'translateY(calc(var(--card-lift, 32px) * -1))' : 'none', zIndex: isSel ? n + i : i, transition: 'left .18s ease, transform .12s ease' };
          }
          // Card-switch dim: INELIGIBLE cards are greyscaled + softly dimmed (reads as "not
          // pickable", not "disabled/loading" like a flat 40% opacity, and red pips don't go
          // pink); ELIGIBLE cards get a POSITIVE gold ring so the choice is obvious.
          if (eligibleIds) {
            style = eligibleIds.has(id)
              ? { ...style, filter: 'drop-shadow(0 0 6px rgba(232,200,121,0.85))' }
              : { ...style, opacity: 0.55, filter: 'grayscale(100%)' };
          }
          // Staggered deal-in: only on a fresh deal (dealing), following the dealt order.
          const dealDelayMs = dealing ? dealtIdsRef.current.indexOf(id) * 35 : undefined;
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id); }
          };
          return (
            <div
              // Key includes dealKey (bumps only on a fresh deal) so the cards remount ONCE
              // per deal for a clean staggered entrance, but stay mounted across reorder/
              // selection (no flicker) and across the dealing→idle transition.
              key={`${id}#${dealKey}`}
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
              <CardView card={card} big selected={isSel} dealDelayMs={dealDelayMs} style={{ width: CARD_W, height: CARD_H, pointerEvents: 'none' }} />
            </div>
          );
        })}
      </div>
    </div>
  );
});
