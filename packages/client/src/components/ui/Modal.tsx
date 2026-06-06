// Lightweight modal: dimmed backdrop + glass panel. Closes on backdrop click,
// the ✕ button, or Escape. Rendered through a portal to <body> so it sits above
// ALL page chrome (the lobby's animated panels create stacking contexts that would
// otherwise trap a modal rendered inside them — making it appear behind content).
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './useFocusTrap.ts';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
}

export function Modal({ title, onClose, children, maxWidth = 420 }: ModalProps) {
  const trapRef = useFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div
        ref={trapRef}
        tabIndex={-1}
        className="panel-solid w-full p-6 animate-pop outline-none"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="gold-text font-display font-semibold tracking-wide text-xl">{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Mbyll" title="Mbyll">✕</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
