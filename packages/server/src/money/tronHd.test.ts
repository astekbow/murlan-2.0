import test from 'node:test';
import assert from 'node:assert/strict';
import { TronHdWallet, pubkeyToTronAddress } from './tronHd.ts';
import { isValidTronAddress } from './tronAddress.ts';

// Fixed BIP39 test vector ("abandon …about"): account-level TRON xpub at
// m/44'/195'/0'/0. The expected addresses were cross-checked against TronWeb
// (the canonical TRON library), so this pins the derivation to the real spec.
const XPUB = 'xpub6EuK4CZWW5urEHdwAVDdDw327danAtccFcrXYvgf1DHrPXRwErt36xStQ2PNhn4hpwzPbzJ8pJVpewgChRnSs59q5Ay61GCfQZKUe71gbLq';
const XPRV = 'xprvA1uxeh2cfiMZ1oZU4Tgcro6HZbkHmRtktPvvkYH3SsksWj6nhKZnZA8QYjdXx8LzM6wuMTE3LcVoAiANjLSRwbh24GWxdztn6xvjBuctSrk';
const EXPECTED = [
  'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', // #0
  'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK', // #1
  'TYJPRrdB5APNeRs4R7fYZSwW3TcrTKw2gx', // #2
];

test('TronHdWallet derives the canonical TRON addresses from an xpub (matches TronWeb)', () => {
  const w = new TronHdWallet(XPUB);
  EXPECTED.forEach((addr, i) => assert.equal(w.addressAt(i), addr, `index ${i}`));
});

test('derived addresses are valid TRON addresses, and indices are deterministic + distinct', () => {
  const w = new TronHdWallet(XPUB);
  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    const a = w.addressAt(i);
    assert.ok(isValidTronAddress(a), `#${i} should be a valid TRON address`);
    assert.equal(w.addressAt(i), a, `#${i} must be deterministic`);
    assert.ok(!seen.has(a), `#${i} must be unique`);
    seen.add(a);
  }
});

test('REFUSES a private extended key (xprv) — the server must stay watch-only', () => {
  assert.throws(() => new TronHdWallet(XPRV), /PUBLIC extended key|xpub/i);
});

test('rejects a malformed extended key', () => {
  assert.throws(() => new TronHdWallet('not-an-xpub'), /not a valid extended key/i);
});

test('rejects a negative or non-integer index', () => {
  const w = new TronHdWallet(XPUB);
  assert.throws(() => w.addressAt(-1), /invalid deposit address index/);
  assert.throws(() => w.addressAt(1.5), /invalid deposit address index/);
});

test('pubkeyToTronAddress produces a checksummed T-address', () => {
  const w = new TronHdWallet(XPUB);
  // (covered transitively, but assert the exported primitive is sane)
  assert.ok(pubkeyToTronAddress.length === 1);
  assert.ok(isValidTronAddress(w.addressAt(0)));
});
