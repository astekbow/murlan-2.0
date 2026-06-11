import { useCallback, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './ConfirmDialog.tsx';

interface ConfirmOpts {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Promise-based confirmation. Usage:
 *    const { confirm, dialog } = useConfirm();
 *    ...
 *    onClick={async () => { if (await confirm({ title, message, danger: true })) doIt(); }}
 *    ...
 *    return (<>{...}{dialog}</>);
 *  The dialog closes on choice; the caller's button shows its own loading state. */
export function useConfirm() {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  );

  const finish = (value: boolean) => {
    setState((s) => { s?.resolve(value); return null; });
  };

  const dialog: ReactNode = state ? (
    <ConfirmDialog
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      danger={state.danger}
      onConfirm={() => finish(true)}
      onClose={() => finish(false)}
    />
  ) : null;

  return { confirm, dialog };
}
