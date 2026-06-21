import { test, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { Card } from '@murlan/engine';
import { Hand } from './Hand.tsx';
import { cardKey } from '../lib/cards.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

test('renders one toggle slot per card and toggles on keyboard select', () => {
  const cards = [c('3', 'S'), c('7', 'H'), c('K', 'D')];
  const onToggle = vi.fn();
  const { container } = render(<Hand cards={cards} selected={[]} onToggle={onToggle} />);

  const slots = container.querySelectorAll('.hand-card');
  expect(slots.length).toBe(3); // a keyboard-operable slot per card

  // Enter on a card toggles it by stable card id (the hand auto-sorts, so just assert
  // the id is one of OUR cards').
  fireEvent.keyDown(slots[0]!, { key: 'Enter' });
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(cards.map(cardKey)).toContain(onToggle.mock.calls[0]![0]);
});

test('a selected card exposes aria-pressed=true', () => {
  const cards = [c('5', 'C')];
  const { container } = render(<Hand cards={cards} selected={[cardKey(cards[0]!)]} onToggle={() => {}} />);
  const slot = container.querySelector('.hand-card');
  expect(slot?.getAttribute('aria-pressed')).toBe('true');
});

test('an empty hand renders no card slots', () => {
  const { container } = render(<Hand cards={[]} selected={[]} onToggle={() => {}} />);
  expect(container.querySelectorAll('.hand-card').length).toBe(0);
});
