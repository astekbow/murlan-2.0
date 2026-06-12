import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog.tsx';

test('shows the message and fires onConfirm when confirmed', () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog title="T" message="Are you sure?" confirmLabel="Yes" cancelLabel="No" onConfirm={onConfirm} onClose={onClose} />,
  );
  expect(screen.getByText('Are you sure?')).toBeTruthy();
  fireEvent.click(screen.getByText('Yes'));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

test('fires onClose when cancelled', () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog title="T" message="m" confirmLabel="Yes" cancelLabel="No" onConfirm={onConfirm} onClose={onClose} />,
  );
  fireEvent.click(screen.getByText('No'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});
