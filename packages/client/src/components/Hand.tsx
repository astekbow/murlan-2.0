import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
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
  /** True on MY turn → a pulsing gold aura around the fan so it's unmistakable it's my move. */
  myTurn?: boolean;
}

/** Weakest→strongest by Murlan power (3…10,J,Q,K,A,2, black joker, red joker). */
const sortIds = (cards: Card[]): string[] =>
  [...cards].sort((a, b) => singlePower(a) - singlePower(b)).map(cardKey);

/** A finger always jitters a few px on a tap: below this it's a tap (select), past it a drag (reorder). */
const DRAG_SLOP_PX = 10;

/** Horizontal slot position. On the OUTER card wrapper only (compositor-friendly transform), so the
 *  inner element stays free for the selected-lift + the just-received pop animation. */
const slotTransform = (x: number) => `translate3d(${x}px,0,0)`;

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  /** Pointer offset from the card's left edge at grab time — the card stays under the finger exactly where it was picked up. */
  grab: number;
  stageLeft: number;
  /** Current card left (px, stage coords). */
  x: number;
  moved: boolean;
}

/**
 * The local player's hand: shown as a fan, auto-sorted weakest→strongest by
 * default, and freely RE-ORDERABLE by drag (pointer = mouse + touch). A short
 * press toggles selection; a drag moves the card. The fan width is fitted to the
 * available space so EVERY card is visible (it never overflows off-screen).
 * Display/order only — moves are sent to the server by card id.
 *
 * Drag mechanics (smoothness): the pointer is captured on the STAGE, which never moves in the DOM —
 * capturing on the card broke the drag the moment React re-ordered that card's node (moving a node
 * drops its pointer capture, so dragging RIGHT used to stall after one slot). The dragged card follows
 * the finger via a direct, rAF-batched transform write (no React render per pointermove); React only
 * re-renders when the card crosses into a new slot, and the other cards GLIDE to their new places.
 */
// Memoized: with a stable onToggle (TableView useCallbacks it) the hand skips
// re-rendering on unrelated table updates (an opponent's move, a timer tick) — it
// only re-renders when the cards/selection/eligibility actually change.
export const Hand = memo(function Hand({ cards, selected, onToggle, eligibleIds, fit, myTurn }: HandProps) {
  const byId = new Map(cards.map((c) => [cardKey(c), c] as const));
  const selectedSet = new Set(selected);

  const [order, setOrder] = useState<string[]>(() => sortIds(cards));
  // Cards that JUST arrived (a received swap card / a fresh deal) — briefly highlighted so the
  // player sees them "land" in the hand (e.g. the winner visibly receiving the loser's big card).
  const [justAdded, setJustAdded] = useState<ReadonlySet<string>>(new Set());
  // Reconcile on hand change: PRESERVE the player's manual order for surviving cards and slot any
  // NEW card into its sorted-by-power position — so a reorder isn't wiped just because one card was
  // received/played. A full fresh deal (nothing survives) sorts from scratch.
  useEffect(() => {
    const present = new Set(cards.map(cardKey));
    setOrder((prev) => {
      const survivors = prev.filter((id) => present.has(id));
      if (survivors.length === 0) return sortIds(cards);
      const newIds = cards.filter((c) => !prev.includes(cardKey(c)));
      if (newIds.length === 0) return survivors;
      const merged = [...survivors];
      for (const c of newIds) {
        const pw = singlePower(c);
        let idx = merged.findIndex((mid) => singlePower(byId.get(mid)!) > pw);
        if (idx === -1) idx = merged.length;
        merged.splice(idx, 0, cardKey(c));
      }
      return merged;
    });
    // Flag the newly-arrived cards (but not the very first deal into an empty hand) for a brief glow.
    const fresh = cards.map(cardKey).filter((id) => !order.includes(id));
    if (order.length > 0 && fresh.length > 0 && fresh.length < cards.length) {
      setJustAdded(new Set(fresh));
      const timer = setTimeout(() => setJustAdded(new Set()), 1600);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    CARD_W = Math.max(64, Math.min(w < 520 ? 86 : 102, Math.floor(w * 0.86))); // floor so cards (+ their tap area) never shrink unbounded on a narrow canvas
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
  // Landscape cards are taller+thinner (1.82) so a narrow card still reads as big; portrait keeps 1.4.
  const CARD_H = Math.round(CARD_W * (fit ? 1.82 : 1.4));
  const stageW = (n - 1) * step + CARD_W;
  // Stable style object → the memoized CardView skips re-rendering while cards slide around.
  const cardStyle = useMemo<CSSProperties>(() => ({ width: CARD_W, height: CARD_H, pointerEvents: 'none' }), [CARD_W, CARD_H]);

  // ---------- drag-to-reorder ----------
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const rafRef = useRef(0);
  // Latest layout + callback for the pointer handlers (a drag outlives several renders).
  const layout = useRef({ ids, step, n, CARD_W });
  layout.current = { ids, step, n, CARD_W };
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;

  const applyDrag = () => {
    rafRef.current = 0;
    const d = dragRef.current;
    if (!d || !d.moved) return;
    cardEls.current.get(d.id)?.style.setProperty('transform', slotTransform(d.x));
    const { ids: cur, step: st, n: count } = layout.current;
    if (st <= 0) return;
    const target = Math.max(0, Math.min(count - 1, Math.round(d.x / st)));
    const from = cur.indexOf(d.id);
    if (from === -1 || from === target) return;
    const next = cur.slice();
    next.splice(from, 1);
    next.splice(target, 0, d.id);
    setOrder(next); // the neighbours glide into their new slots (CSS transition)
  };

  const onCardDown = (id: string, e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (dragRef.current) return; // a second finger mid-drag is ignored
    const stage = stageRef.current;
    if (!stage) return;
    const stageLeft = stage.getBoundingClientRect().left;
    const cardLeft = Math.max(0, layout.current.ids.indexOf(id)) * layout.current.step;
    dragRef.current = { id, pointerId: e.pointerId, startX: e.clientX, grab: e.clientX - stageLeft - cardLeft, stageLeft, x: cardLeft, moved: false };
    try { stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  };

  const onStageMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) <= DRAG_SLOP_PX) return; // still a tap
      d.moved = true;
      setDragId(d.id);
    }
    const { step: st, n: count, CARD_W: cw } = layout.current;
    const maxX = Math.max(0, (count - 1) * st);
    d.x = Math.max(-cw * 0.25, Math.min(maxX + cw * 0.25, e.clientX - d.stageLeft - d.grab));
    if (!rafRef.current) rafRef.current = requestAnimationFrame(applyDrag);
  };

  const endDrag = (e: PointerEvent, isTap: boolean) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    try { stageRef.current?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (isTap && !d.moved) onToggleRef.current(d.id);
    setDragId(null);
  };

  // Drop: the card's transform was last written directly (not by React), so make sure it is sent
  // back to its slot — it then glides there via the restored CSS transition.
  const lastDragged = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (dragId) { lastDragged.current = dragId; return; }
    const id = lastDragged.current;
    lastDragged.current = null;
    if (!id) return;
    const i = layout.current.ids.indexOf(id);
    if (i >= 0) cardEls.current.get(id)?.style.setProperty('transform', slotTransform(i * layout.current.step));
  }, [dragId]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

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
      // fit mode sizes the fan to fit the zone width (no h-overflow), so plain `visible`
      // lets the tall cards peek UP without the clip+visible combo that CSS forbids — that
      // combo was clipping/flickering the top of the cards.
      style={fit ? { overflow: 'visible' } : undefined}
    >
      <div
        ref={stageRef}
        className={`hand-stage${myTurn ? ' my-turn' : ''}${dragId ? ' dragging' : ''}`}
        style={{ width: stageW, height: CARD_H + 34 }}
        onPointerMove={onStageMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onLostPointerCapture={(e) => endDrag(e, false)}
      >
        {ids.map((id, i) => {
          const card = byId.get(id);
          if (!card) return null;
          const isSel = selectedSet.has(id);
          const dragging = dragId === id;
          // Straight row. The dragged card rides on top (z 50) at the finger's position; every
          // other card sits in its slot with natural stacking (z = i) so a SELECTED card's
          // raised top edge (rank + gold ring) peeks above the row without covering its neighbours.
          const x = dragging && dragRef.current ? dragRef.current.x : i * step;
          const style: CSSProperties = { transform: slotTransform(x), zIndex: dragging ? 50 : i };
          if (eligibleIds && !eligibleIds.has(id)) style.opacity = 0.4;
          const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id); }
          };
          return (
            <div
              key={id}
              ref={(el) => { if (el) cardEls.current.set(id, el); else cardEls.current.delete(id); }}
              className={`hand-card${dragging ? ' dragging' : ''}`}
              style={style}
              // Keyboard + screen-reader access: each card is a labelled toggle
              // button (pointer users also drag to reorder; keyboard users select).
              role="button"
              tabIndex={0}
              aria-label={cardAriaLabel(card)}
              aria-pressed={isSel}
              onKeyDown={onKey}
              onPointerDown={(e) => onCardDown(id, e)}
            >
              <div className={`hand-card-lift${isSel ? ' sel' : ''}${justAdded.has(id) ? ' just-added' : ''}`}>
                <CardView card={card} big selected={isSel} decorative style={cardStyle} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
