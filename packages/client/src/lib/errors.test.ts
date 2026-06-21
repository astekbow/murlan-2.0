import { test, expect, beforeEach } from 'vitest';
import { errText, ackText } from './errors.ts';
import { useLangStore } from './i18n.ts';

// Error TEXT for money/admin flows is localized on the client by a stable server CODE.
// These guard that mapping (used by every wallet/admin error toast).
beforeEach(() => useLangStore.setState({ lang: 'en' }));

test('errText maps a known code to the localized catalog string', () => {
  expect(errText('network')).toBe('Connection to the server failed. Check your internet.');
  expect(errText('session_expired')).toBe('The session expired — log in again.');
});

test('errText falls back to the server message for an UNmapped code', () => {
  expect(errText('insufficient_balance_xyz', 'You only have $3.00')).toBe('You only have $3.00');
});

test('errText falls back to a generic message when there is no code and no server message', () => {
  expect(errText(undefined)).toBe('Something went wrong.');
});

test('errText follows the language (sq)', () => {
  useLangStore.setState({ lang: 'sq' });
  expect(errText('network')).toBe('Lidhja me serverin dështoi. Kontrollo internetin.');
});

test('ackText prefers the mapped code over the server message', () => {
  // A socket ack carries an Albanian fallback message, but the CODE localizes it.
  expect(ackText({ code: 'timeout', message: 'Serveri nuk u përgjigj. Provo sërish.' }, 'err.generic'))
    .toBe('The server did not respond. Try again.');
});

test('ackText uses the server message when the code is unmapped, then the fallback key', () => {
  expect(ackText({ code: 'weird', message: 'specific detail' }, 'err.generic')).toBe('specific detail');
  expect(ackText(undefined, 'err.network')).toBe('Connection to the server failed. Check your internet.');
});
