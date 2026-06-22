import { test, expect, beforeEach, vi } from 'vitest';

// Mock the socket layer so the store wires its handlers onto a FAKE socket we control,
// and `request` (room:create/join acks) returns what each test sets. vi.hoisted lets the
// vi.mock factory reference these (the factory is hoisted above imports).
const h = vi.hoisted(() => {
  const handlers = new Map<string, (arg: unknown) => void>();
  const fakeSocket = {
    on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
    emit: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
  };
  return { handlers, fakeSocket, requestImpl: (async () => ({ ok: true })) as (...a: unknown[]) => Promise<unknown> };
});

vi.mock('../lib/socket.ts', () => ({
  connectSocket: () => h.fakeSocket,
  request: (...args: unknown[]) => h.requestImpl(...args),
}));

import { useGameStore } from './gameStore.ts';

const INITIAL = { ...useGameStore.getState() };
const fire = (event: string, payload: unknown) => {
  const cb = h.handlers.get(event);
  if (!cb) throw new Error(`no handler registered for ${event}`);
  cb(payload);
};

beforeEach(() => {
  useGameStore.setState(INITIAL, true); // full reset (incl. socket=null so connect() re-runs)
  h.handlers.clear();
  h.requestImpl = async () => ({ ok: true });
  h.fakeSocket.emit.mockClear();
  useGameStore.getState().connect(() => 'tok', 'me'); // registers all socket.on handlers
});

test('connect stores the socket + my user id and registers handlers', () => {
  expect(useGameStore.getState().myUserId).toBe('me');
  expect(useGameStore.getState().socket).toBe(h.fakeSocket);
  expect(h.handlers.has('game:start')).toBe(true);
  expect(h.handlers.has('match:end')).toBe(true);
});

test('game:start sets hand/seat/game + clears selection & pile history', () => {
  useGameStore.setState({ selected: [{ rank: 3, suit: 0 } as never], pileHistory: [[]] as never });
  fire('game:start', { hand: [{ rank: 3, suit: 0 }], yourSeat: 2, state: { pile: null }, gameIndex: 0 });
  const s = useGameStore.getState();
  expect(s.mySeat).toBe(2);
  expect(s.myHand).toHaveLength(1);
  expect(s.game).toEqual({ pile: null });
  expect(s.selected).toEqual([]);
  expect(s.pileHistory).toEqual([]);
  expect(s.handStandings).toBeNull();
});

test('game:state replaces the public game state', () => {
  fire('game:state', { pile: null, turn: 1 });
  expect(useGameStore.getState().game).toEqual({ pile: null, turn: 1 });
});

test('game:end records the hand standings + scoreboard (board kept visible)', () => {
  fire('game:end', { scoreboard: { rows: [] }, finishingOrder: [0, 1, 2, 3], gameIndex: 0 });
  const s = useGameStore.getState();
  expect(s.handStandings).toMatchObject({ finishingOrder: [0, 1, 2, 3], gameIndex: 0 });
  expect(s.scoreboard).toEqual({ rows: [] });
});

test('match:end sets the result, stops the board, and detects MY win', () => {
  useGameStore.setState({ mySeat: 1 });
  fire('match:end', { winnerSeats: [1, 3], scoreboard: { rows: [] } });
  const s = useGameStore.getState();
  expect(s.matchResult).toMatchObject({ winnerSeats: [1, 3] });
  expect(s.game).toBeNull(); // board cleared behind the overlay
  expect(s.handStandings).toBeNull();
});

test('lobby:state + room:state update their slices', () => {
  fire('lobby:state', { rooms: [{ id: 'r1' }], live: [{ id: 'm1' }] });
  expect(useGameStore.getState().lobby).toEqual([{ id: 'r1' }]);
  expect(useGameStore.getState().live).toEqual([{ id: 'm1' }]);

  fire('room:state', { id: 'r1', seats: [{ userId: 'me' }, { userId: 'x' }] });
  expect(useGameStore.getState().room).toMatchObject({ id: 'r1' });
  expect(useGameStore.getState().mySeat).toBe(0); // my seat located by userId
});

test('createRoom sends room:create with the stake and returns the new room id', async () => {
  const seen: unknown[][] = [];
  h.requestImpl = async (...a: unknown[]) => { seen.push(a); return { ok: true, roomId: 'room42' }; };
  const id = await useGameStore.getState().createRoom('1v1', 500, undefined, false);
  expect(id).toBe('room42');
  expect(seen[0]![1]).toBe('room:create');
  expect(seen[0]![2]).toMatchObject({ type: '1v1', stakeCents: 500, private: false });
});

test('createRoom surfaces a toast + returns null when the server rejects', async () => {
  h.requestImpl = async () => ({ ok: false, error: { code: 'insufficient_funds' } });
  const id = await useGameStore.getState().createRoom('1v1', 999999, undefined, false);
  expect(id).toBeNull();
  expect(useGameStore.getState().toast).toBeTruthy();
  expect(useGameStore.getState().toastKind).toBe('error');
});

test('joinRoom returns the ack ok flag', async () => {
  h.requestImpl = async () => ({ ok: true });
  expect(await useGameStore.getState().joinRoom('r1')).toBe(true);
  h.requestImpl = async () => ({ ok: false, error: { code: 'full' } });
  expect(await useGameStore.getState().joinRoom('r1')).toBe(false);
});

test('tournament:matchReady auto-joins the paired room', async () => {
  const seen: unknown[][] = [];
  h.requestImpl = async (...a: unknown[]) => { seen.push(a); return { ok: true }; };
  fire('tournament:matchReady', { roomId: 'trnRoom' });
  await Promise.resolve(); // let the fire-and-forget joinRoom settle
  expect(seen.some((a) => a[1] === 'room:join' && (a[2] as { roomId: string }).roomId === 'trnRoom')).toBe(true);
});
