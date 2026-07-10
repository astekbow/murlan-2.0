import { useState, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../lib/i18n.ts';

export interface RowMenuItem {
  key: string;
  label: ReactNode;
  onClick: () => void;
  danger?: boolean; // destructive (Remove / Block) → red
  disabled?: boolean;
}

/** A compact "⋯" overflow menu for a list row — keeps ONE primary action prominent and tucks the
 *  secondary/destructive ones (Send money, Remove, Block…) behind a tap, instead of a pile of
 *  equal-weight ghost buttons where destructive and primary read the same.
 *
 *  The dropdown is PORTALED to #root with fixed positioning (anchored to the button) so it is NOT
 *  clipped by an ancestor `.panel { overflow:hidden }` — an absolutely-positioned menu inside a
 *  clipped panel had its lower items (Remove/Block) cut off on the last rows. It also flips ABOVE
 *  the button when there isn't room below. */
export function RowMenu({ items, label }: { items: RowMenuItem[]; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  if (items.length === 0) return null;

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const menuH = items.length * 40 + 8; // rough estimate for the flip decision
      const right = Math.max(8, window.innerWidth - r.right); // right-align to the button, min 8px gutter
      const openUp = r.bottom + menuH > window.innerHeight - 8; // no room below → flip above
      setPos({ right, ...(openUp ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
    }
    setOpen(true);
  };

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ?? t('common.more')}
        onClick={toggle}
        className="btn btn-ghost btn-sm px-2.5"
      >
        ⋯
      </button>
      {open && pos && createPortal(
        <>
          {/* Click-away catcher. */}
          <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="fixed z-[81] min-w-[168px] panel-solid rounded-xl py-1 shadow-2xl ring-1 ring-white/10"
            style={{ right: pos.right, top: pos.top, bottom: pos.bottom, maxHeight: '70dvh', overflowY: 'auto' }}
          >
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}
                className={`w-full text-left px-3.5 py-2 text-sm hover:bg-white/[.06] disabled:opacity-40 whitespace-nowrap ${it.danger ? 'text-red-300' : 'text-txt'}`}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>,
        document.getElementById('root') ?? document.body,
      )}
    </div>
  );
}
