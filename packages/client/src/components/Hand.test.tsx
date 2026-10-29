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

test('dragging a card re-orders it (no select); a small jitter is still a tap (select)', () => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  try {
    const cards = [c('3', 'S'), c('7', 'H'), c('K', 'D')];
    const onToggle = vi.fn();
    const { container } = render(<Hand cards={cards} selected={[]} onToggle={onToggle} />);
    const stage = container.querySelector('.hand-stage')!;
    const order = () => [...container.querySelectorAll('.hand-card')].map((el) => el.getAttribute('aria-label'));
    const before = order();

    // Grab the FIRST card and drag it far right — the pointer is captured on the stage, so the
    // moves/up land there even after the card's node is re-ordered.
    fireEvent.pointerDown(container.querySelectorAll('.hand-card')[0]!, { pointerId: 1, clientX: 10, button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 120 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 400 });
    expect(onToggle).not.toHaveBeenCalled();
    expect(order()).toEqual([before[1], before[2], before[0]]);

    // A 4px finger jitter is a TAP: selects, never moves.
    const tapped = container.querySelectorAll('.hand-card')[0]!;
    fireEvent.pointerDown(tapped, { pointerId: 2, clientX: 50, button: 0 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 54 });
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 54 });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(order()).toEqual([before[1], before[2], before[0]]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('an empty hand renders no card slots', () => {
  const { container } = render(<Hand cards={[]} selected={[]} onToggle={() => {}} />);
  expect(container.querySelectorAll('.hand-card').length).toBe(0);
});
