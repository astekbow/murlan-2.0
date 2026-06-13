import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidTronAddress } from './tronAddress.ts';

test('accepts real mainnet TRON addresses (valid checksum)', () => {
  assert.equal(isValidTronAddress('TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6'), true); // the owner's deposit address
  assert.equal(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), true); // USDT-TRC20 contract
});

test('rejects a one-character typo (checksum fails)', () => {
  // flip the last char → checksum no longer matches
  assert.equal(isValidTronAddress('TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR7'), false);
});

test('rejects wrong prefix, wrong length, and non-base58 chars', () => {
  assert.equal(isValidTronAddress('AUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6'), false); // not 'T'
  assert.equal(isValidTronAddress('TUcs'), false);                                // too short
  assert.equal(isValidTronAddress('TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6X'), false);  // too long
  assert.equal(isValidTronAddress('T0OIl1111111111111111111111111111'), false);   // base58 excludes 0 O I l
});

test('rejects non-strings / empty', () => {
  assert.equal(isValidTronAddress(''), false);
  assert.equal(isValidTronAddress(undefined), false);
  assert.equal(isValidTronAddress(123 as unknown as string), false);
  // a BTC/ETH-style address must not pass the TRON check
  assert.equal(isValidTronAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'), false);
});
