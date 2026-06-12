import { test, expect, beforeEach } from 'vitest';
import { useUiStore } from './uiStore.ts';

beforeEach(() => useUiStore.getState().reset());

test('setView changes the active lobby view', () => {
  useUiStore.getState().setView('wallet');
  expect(useUiStore.getState().view).toBe('wallet');
});

test('openReplay / closeReplay toggle the replay match id', () => {
  useUiStore.getState().openReplay('m1');
  expect(useUiStore.getState().replayMatchId).toBe('m1');
  useUiStore.getState().closeReplay();
  expect(useUiStore.getState().replayMatchId).toBeNull();
});

test('reset returns to the lobby and clears replay (used on logout)', () => {
  useUiStore.getState().setView('admin');
  useUiStore.getState().openReplay('m2');
  useUiStore.getState().reset();
  expect(useUiStore.getState().view).toBe('lobby');
  expect(useUiStore.getState().replayMatchId).toBeNull();
});
