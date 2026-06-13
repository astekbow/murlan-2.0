// ============================================================================
// MURLAN — TRON HD deposit-address derivation (WATCH-ONLY, from an xpub)
// ----------------------------------------------------------------------------
// Gives every player a UNIQUE on-chain USDT-TRC20 deposit address, so an arrived
// deposit is attributed to exactly one account by WHICH address received it — and
// can never be claim-jacked (a stranger can't make you send to a different address,
// and can't claim funds sent to an address that isn't theirs).
//
// CUSTODY: the server holds ONLY the account-level xpub (extended PUBLIC key). It
// can derive each player's address but CANNOT spend — no private keys ever touch
// the server, so a host breach cannot move deposited funds. The owner controls the
// funds with the offline mnemonic (kept in cold storage) and consolidates manually.
//
// The derivation matches TronWeb exactly (verified against the canonical lib): the
// xpub is the node at m/44'/195'/0'/0, and child index i is the address for player
// index i. Same logic as tools/tron-xpub.mjs (the operator's offline generator).
// ============================================================================

import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { isValidTronAddress } from './tronAddress.ts';

/** secp256k1 public key (compressed, 33 bytes) → TRON base58check address (T...). */
export function pubkeyToTronAddress(pubkeyCompressed: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(pubkeyCompressed).toBytes(false); // 65 bytes: 0x04 || X || Y
  const hash = keccak_256(uncompressed.slice(1));            // keccak256 over X||Y
  const addr21 = new Uint8Array(21);
  addr21[0] = 0x41;                                          // TRON mainnet prefix
  addr21.set(hash.slice(-20), 1);                            // last 20 bytes of the hash
  const checksum = sha256(sha256(addr21)).slice(0, 4);       // double-sha256 checksum
  const full = new Uint8Array(25);
  full.set(addr21, 0);
  full.set(checksum, 21);
  return bs58.encode(full);
}

/**
 * Watch-only HD wallet over an account-level TRON xpub. addressAt(i) derives the
 * deposit address for player index i (m/44'/195'/0'/0/i). Constructed from config
 * (TRON_DEPOSIT_XPUB); throws if given a PRIVATE extended key (an xprv must never
 * reach the server) or a malformed key.
 */
export class TronHdWallet {
  private readonly node: HDKey;

  constructor(xpub: string) {
    let node: HDKey;
    try {
      node = HDKey.fromExtendedKey(xpub.trim());
    } catch (e) {
      throw new Error(`TRON_DEPOSIT_XPUB is not a valid extended key: ${String(e)}`);
    }
    // SAFETY: refuse a private extended key — the server must be watch-only.
    if (node.privateKey != null) {
      throw new Error('TRON_DEPOSIT_XPUB must be a PUBLIC extended key (xpub), never a private one (xprv).');
    }
    this.node = node;
  }

  /** Derive the deposit address for a player index (>= 0). */
  addressAt(index: number): string {
    if (!Number.isInteger(index) || index < 0) throw new Error(`invalid deposit address index: ${index}`);
    const child = this.node.deriveChild(index);
    if (!child.publicKey) throw new Error('failed to derive child public key');
    const address = pubkeyToTronAddress(child.publicKey);
    // Defense-in-depth: never hand out a malformed address.
    if (!isValidTronAddress(address)) throw new Error('derived an invalid TRON address');
    return address;
  }
}
