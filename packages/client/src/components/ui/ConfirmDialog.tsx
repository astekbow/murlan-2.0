import type { ReactNode } from 'react';
import { Modal } from './Modal.tsx';
import { useT } from '../../lib/i18n.ts';

interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red) and require an explicit choice. */
  danger?: boolean;
  /** Show a spinner + disable while the confirmed action runs. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** A small confirm/cancel dialog for irreversible or money-moving actions. Built on
 *  Modal (focus-trap, Escape, backdrop-close, safe-area). */
export function ConfirmDialog({
  title, message, confirmLabel, cancelLabel, danger, busy, onConfirm, onClose,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <Modal title={title} onClose={onClose} maxWidth={400}>
      <div className="space-y-5">
        <div className="text-sm text-txt leading-relaxed">{message}</div>
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-gold'}${busy ? ' btn-loading' : ''}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
