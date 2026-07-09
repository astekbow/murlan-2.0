import { useState, type ReactNode } from 'react';
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
 *  equal-weight ghost buttons where destructive and primary read the same. */
export function RowMenu({ items, label }: { items: RowMenuItem[]; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ?? t('common.more')}
        onClick={() => setOpen((o) => !o)}
        className="btn btn-ghost btn-sm px-2.5"
      >
        ⋯
      </button>
      {open && (
        <>
          {/* Click-away catcher. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div role="menu" className="absolute right-0 top-full mt-1 z-50 min-w-[168px] panel-solid rounded-xl py-1 shadow-2xl ring-1 ring-white/10">
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}
                className={`w-full text-left px-3.5 py-2 text-sm hover:bg-white/[.06] disabled:opacity-40 ${it.danger ? 'text-red-300' : 'text-txt'}`}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
