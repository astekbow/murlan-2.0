import { test, expect, beforeEach } from 'vitest';
import { useNotifications } from './notificationsStore.ts';

// The in-app 🔔 store: bell-badge count (`unread`), the capped item list, and the read/clear actions
// the NotificationsPanel drives. Pure store logic — no DOM.

beforeEach(() => {
  useNotifications.setState({ items: [], unread: 0 });
});

test('push prepends newest, bumps unread, and carries kind + deep-link', () => {
  const { push } = useNotifications.getState();
  push('first');
  push('second', 'deposit', { view: 'wallet' });

  const s = useNotifications.getState();
  expect(s.items.map((n) => n.text)).toEqual(['second', 'first']); // newest first
  expect(s.unread).toBe(2);
  expect(s.items[0].kind).toBe('deposit');
  expect(s.items[0].view).toBe('wallet');
  expect(s.items[1].kind).toBe('info'); // default kind
  expect(s.items[0].id).not.toBe(s.items[1].id); // unique ids
});

test('the list is capped at 40 (oldest dropped)', () => {
  const { push } = useNotifications.getState();
  for (let i = 0; i < 45; i++) push(`n${i}`);
  const s = useNotifications.getState();
  expect(s.items).toHaveLength(40);
  expect(s.items[0].text).toBe('n44'); // newest kept
  expect(s.items.at(-1)!.text).toBe('n5'); // first 5 dropped
  expect(s.unread).toBe(45); // unread counts every push, not just the kept items
});

test('markRead clears the badge but keeps the items', () => {
  const { push, markRead } = useNotifications.getState();
  push('a'); push('b');
  markRead();
  const s = useNotifications.getState();
  expect(s.unread).toBe(0);
  expect(s.items).toHaveLength(2); // list untouched
});

test('clear empties both the list and the badge', () => {
  const { push, clear } = useNotifications.getState();
  push('a'); push('b');
  clear();
  const s = useNotifications.getState();
  expect(s.items).toHaveLength(0);
  expect(s.unread).toBe(0);
});
