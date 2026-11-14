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
   * How the table is laid out. PORTRAIT sizes cards from the available WIDTH; LANDSCAPE (and
   * desktop) sizes them from the viewport HEIGHT so the felt keeps its room. Either way the hand
   * never squeezes the cards below a readable overlap — it wraps to TWO rows instead.
   */
  layout?: 'portrait' | 'landscape';
  /** True on MY turn → a pulsing glow behind the hand so it's unmistakable it's my move. */
  myTurn?: boolean;
}

/** Weakest→strongest by Murlan power (3…10,J,Q,K,A,2, black joker, red joker). */
const sortIds = (cards: Card[]): string[] =>
  [...cards].sort((a, b) => singlePower(a) - singlePower(b)).map(cardKey);

/** A finger always jitters a few px on a tap: below this it's a tap (select), past it a drag (reorder). */
const DRAG_SLOP_PX = 10;
/** The narrowest overlap that still shows a card's whole corner index (incl. "10"). Below it the
 *  hand switches to two rows rather than squeezing the cards together. */
const MIN_STEP_PX = 30;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Slot transform. On the OUTER card wrapper only (compositor-friendly), so the inner element
 *  stays free for the selected-lift + the just-received pop animation. */
const slotTransform = (x: number, y: number) => `translate3d(${x}px,${y}px,0)`;

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer offset from the card's top-left at grab time — the card stays under the finger exactly where it was picked up. */
  grabX: number;
  grabY: number;
  stageLeft: number;
  stageTop: number;
  /** Current card top-left (px, stage coords). */
  x: number;
  y: number;
  moved: boolean;
}

/** Pure layout of the fan: card size, overlap step, one or two rows, and each slot's position. */
function computeLayout(n: number, availW: number, vh: number, layout: 'portrait' | 'landscape', reserveRows = 1) {
  const w = availW || 340;
  const landscape = layout === 'landscape';
  const cardW = Math.round(landscape ? clamp(vh * 0.17, 56, 92) : clamp(w / 5.4, 58, 76));
  const cardH = Math.round(cardW * 1.42);
  const maxStep = cardW * (landscape ? 0.7 : 0.62);
  const oneRowStep = n > 1 ? (w - cardW) / (n - 1) : 0;
  const rows = n > 1 && oneRowStep < MIN_STEP_PX ? 2 : 1;
  const perRow0 = rows === 2 ? Math.ceil(n / 2) : n;
  const perRow1 = n - perRow0;
  const rawStep = rows === 2 ? (w - cardW) / Math.max(1, perRow0 - 1) : oneRowStep;
  const step = n > 1 ? Math.max(0, Math.min(maxStep, rawStep)) : 0;
  const lift = landscape ? 18 : 24;
  const rowOffset = Math.round(cardH * 0.5);
  const rowWidth = (len: number) => (len > 0 ? (len - 1) * step + cardW : 0);
  const stageW = rowWidth(perRow0);
  // The stage keeps the height of the most rows this deal has needed (reserveRows), so the hand area
  // — and with it the felt above — never jumps when the hand drops from two rows to one or empties.
  // A single row then sits in the FRONT-row position (bottom), right above Play/Pass.
  const shownRows = Math.max(rows, reserveRows);
  const yBase = (shownRows - rows) * rowOffset;
  const stageH = lift + cardH + (shownRows - 1) * rowOffset;
  const rowOff = (r: 0 | 1) => (stageW - rowWidth(r === 1 ? perRow1 : perRow0)) / 2;
  const slot = (i: number) => {
    const r: 0 | 1 = rows === 2 && i >= perRow0 ? 1 : 0;
    const c = r === 1 ? i - perRow0 : i;
    return { x: rowOff(r) + c * step, y: yBase + lift + r * rowOffset, r };
  };
  /** Where a card dropped at (x, y) belongs, as an index into the hand order. */
  const targetIndex = (x: number, y: number) => {
    if (n <= 1 || step <= 0) return 0;
    const r: 0 | 1 = rows === 2 && y > yBase + lift + rowOffset / 2 ? 1 : 0;
    const len = r === 1 ? perRow1 : perRow0;
    const col = clamp(Math.round((x - rowOff(r)) / step), 0, Math.max(0, r === 1 ? len : len - 1));
    return clamp(r === 1 ? perRow0 + col : col, 0, n - 1);
  };
  return { cardW, cardH, step, rows, lift, yBase, stageW, stageH, slot, targetIndex };
}

/**
 * The local player's hand: a fan (one or two rows), auto-sorted weakest→strongest by default and
 * freely RE-ORDERABLE by drag (pointer = mouse + touch). A short press toggles selection; a drag
 * moves the card. Sized for the orientation and wrapped to two rows before cards would get too
 * tight to read — the cards never shrink into an unreadable sliver. Display/order only — moves are
 * sent to the server by card id.
 *
 * Drag mechanics (smoothness): the pointer is captured on the STAGE, which never moves in the DOM —
 * capturing on the card broke the drag the moment React re-ordered that card's node. The dragged
 * card follows the finger via a direct, rAF-batched transform write (no React render per
 * pointermove); React only re-renders when the card crosses into a new slot, and the other cards
 * GLIDE to their new places.
 */
// Memoized: with a stable onToggle (TableView useCallbacks it) the hand skips re-rendering on
// unrelated table updates (an opponent's move, a timer tick).
export const Hand = memo(function Hand({ cards, selected, onToggle, eligibleIds, layout = 'portrait', myTurn }: HandProps) {
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

  // Measure the available width (before paint → no "small then grow" flash) and track the viewport
  // height (landscape sizes cards from it).
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(0);
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800));
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => { setAvailW(el.clientWidth); setVh(window.innerHeight); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // Sticky row reservation: remember the most rows needed for this table geometry, so playing
  // cards away (two rows → one → none) never shrinks the hand area and shoves the felt around.
  // A new geometry (rotation / resize / card size) starts a fresh reservation.
  const fit = computeLayout(n, availW, vh, layout);
  const peak = useRef({ key: '', rows: 1 });
  const geoKey = `${layout}|${fit.cardW}|${Math.round(availW / 8)}`;
  if (peak.current.key !== geoKey) peak.current = { key: geoKey, rows: fit.rows };
  else if (fit.rows > peak.current.rows) peak.current.rows = fit.rows;
  const L = peak.current.rows > fit.rows ? computeLayout(n, availW, vh, layout, peak.current.rows) : fit;
  // Stable style object → the memoized CardView skips re-rendering while cards slide around.
  const cardStyle = useMemo<CSSProperties>(() => ({ width: L.cardW, height: L.cardH, pointerEvents: 'none' }), [L.cardW, L.cardH]);

  // ---------- drag-to-reorder ----------
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<DragState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const rafRef = useRef(0);
  // Latest layout + callback for the pointer handlers (a drag outlives several renders).
  const layoutRef = useRef({ ids, L });
  layoutRef.current = { ids, L };
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;

  const applyDrag = () => {
    rafRef.current = 0;
    const d = dragRef.current;
    if (!d || !d.moved) return;
    cardEls.current.get(d.id)?.style.setProperty('transform', slotTransform(d.x, d.y));
    const { ids: cur, L: lay } = layoutRef.current;
    const from = cur.indexOf(d.id);
    const target = lay.targetIndex(d.x, d.y);
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
    const rect = stage.getBoundingClientRect();
    const { ids: cur, L: lay } = layoutRef.current;
    const s = lay.slot(Math.max(0, cur.indexOf(id)));
    dragRef.current = {
      id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      grabX: e.clientX - rect.left - s.x, grabY: e.clientY - rect.top - s.y,
      stageLeft: rect.left, stageTop: rect.top, x: s.x, y: s.y, moved: false,
    };
    try { stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  };

  const onStageMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) <= DRAG_SLOP_PX && Math.abs(e.clientY - d.startY) <= DRAG_SLOP_PX) return; // still a tap
      d.moved = true;
      setDragId(d.id);
    }
    const { L: lay } = layoutRef.current;
    d.x = clamp(e.clientX - d.stageLeft - d.grabX, -lay.cardW * 0.25, lay.stageW - lay.cardW * 0.75);
    d.y = clamp(e.clientY - d.stageTop - d.grabY, 0, lay.stageH - lay.cardH);
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
    const { ids: cur, L: lay } = layoutRef.current;
    const i = cur.indexOf(id);
    if (i >= 0) { const s = lay.slot(i); cardEls.current.get(id)?.style.setProperty('transform', slotTransform(s.x, s.y)); }
  }, [dragId]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Empty hand (between deals / after going out) → no cards, but keep the reserved HEIGHT so the
  // table doesn't jump, and keep measuring so the next deal lays out at its final size.
  if (n === 0) return <div ref={scrollRef} className="hand-wrap" aria-hidden><div style={{ height: L.stageH }} /></div>;

  return (
    <div ref={scrollRef} className="hand-wrap">
      <div
        ref={stageRef}
        className={`hand-stage${myTurn ? ' my-turn' : ''}${dragId ? ' dragging' : ''}${L.rows === 2 ? ' two-rows' : ''}`}
        style={{ width: L.stageW, height: L.stageH, '--card-lift': `${L.lift}px`, '--glow-top': `${L.lift + L.yBase}px` } as CSSProperties}
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
          const s = L.slot(i);
          // The dragged card rides on top at the finger's position; every other card sits in its
          // slot with natural stacking (front row above the back row; left → right within a row),
          // so a SELECTED card's raised top edge peeks above its neighbours without covering them.
          const pos = dragging && dragRef.current ? { x: dragRef.current.x, y: dragRef.current.y } : s;
          const style: CSSProperties = { transform: slotTransform(pos.x, pos.y), zIndex: dragging ? 500 : s.r * 100 + i };
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
