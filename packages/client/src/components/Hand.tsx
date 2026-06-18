import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
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
export function Hand({ cards, selected, onToggle, eligibleIds }: HandProps) {
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
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = availW || 340;
  // Bigger, easier-to-read cards (esp. on phones). The fan still fits any hand size —
  // `step` below overlaps them to the available width, so a wider card just overlaps more
  // while its readable top-left rank/suit strip stays visible.
  const CARD_W = w < 420 ? 84 : 98;
  const CARD_H = Math.round(CARD_W * 1.4);
  const maxStep = Math.round(CARD_W * 0.66);
  // Straight row: enough overlap to fit every card, but never less than ~20px so
  // each card's top-left rank stays readable.
  const step = n > 1 ? Math.max(20, Math.min(maxStep, (w - CARD_W - 8) / (n - 1))) : 0;
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

  if (n === 0) {
    return <div className="flex justify-center items-center min-h-[124px]"><span className="text-muted text-sm">Nuk ke letra.</span></div>;
  }

  return (
    <div ref={scrollRef} className="no-scrollbar overflow-x-auto overflow-y-visible max-w-full px-2">
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
            // peeks above the row — it never covers the neighbouring cards. The bigger
            // lift + the gold ring make the pick obvious; unselected cards dim while a
            // selection is active so the chosen combo reads at a glance.
            const dim = !isSel && selectedSet.size > 0;
            style = { left: i * step, bottom: 0, transform: isSel ? 'translateY(calc(var(--card-lift, 32px) * -1))' : 'none', zIndex: i, opacity: dim ? 0.72 : 1, transition: 'transform .12s ease, opacity .12s ease' };
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
}
