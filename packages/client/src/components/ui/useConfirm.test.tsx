import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useConfirm } from './useConfirm.tsx';

// useConfirm is the promise-based gate that protects EVERY destructive/financial
// action (withdraw, self-exclude, account delete, club leave, tournament cancel,
// admin balance/state changes). These tests pin its resolve-on-choice contract.
function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button onClick={async () => onResult(await confirm({ title: 'T', message: 'Move money?', confirmLabel: 'Yes', cancelLabel: 'No', danger: true }))}>
        act
      </button>
      {dialog}
    </>
  );
}

test('confirm() resolves TRUE when the user confirms', async () => {
  const onResult = vi.fn();
  render(<Harness onResult={onResult} />);
  fireEvent.click(screen.getByText('act'));
  expect(await screen.findByText('Move money?')).toBeTruthy(); // dialog shown
  fireEvent.click(screen.getByText('Yes'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
});

test('confirm() resolves FALSE when the user cancels (the safe default)', async () => {
  const onResult = vi.fn();
  render(<Harness onResult={onResult} />);
  fireEvent.click(screen.getByText('act'));
  await screen.findByText('Move money?');
  fireEvent.click(screen.getByText('No'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
});

test('the dialog is dismissed after a choice (no leak into the next action)', async () => {
  const onResult = vi.fn();
  render(<Harness onResult={onResult} />);
  fireEvent.click(screen.getByText('act'));
  await screen.findByText('Move money?');
  fireEvent.click(screen.getByText('No'));
  await waitFor(() => expect(screen.queryByText('Move money?')).toBeNull());
});
