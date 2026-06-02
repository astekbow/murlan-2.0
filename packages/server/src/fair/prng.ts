// ============================================================================
// MURLAN — Provably-fair PRNG (Phase 7, spec §8)
// ----------------------------------------------------------------------------
// A deterministic random stream from HMAC-SHA256(serverSeed, clientSeed:nonce).
// Given the same (serverSeed, clientSeed, nonce) it reproduces the exact same
// sequence — so once serverSeed is revealed, any player can recompute the deal
// and confirm it matches the committed hash. NEVER use Math.random for a deal.
// ============================================================================

import { createHmac } from 'node:crypto';

/**
 * Returns an rng `() => number` in [0, 1) backed by a counter-mode HMAC stream:
 * HMAC(serverSeed, `${clientSeed}:${nonce}:${block}`) yields 32 bytes; each draw
 * consumes 4 bytes as a uint32. Drop-in for engine.shuffle / engine.deal.
 */
export function hmacRng(serverSeed: string, clientSeed: string, nonce: number): () => number {
  let block = 0;
  let buffer = Buffer.alloc(0);
  let pos = 0;

  const refill = () => {
    buffer = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${block}`).digest();
    block += 1;
    pos = 0;
  };

  return () => {
    if (pos + 4 > buffer.length) refill();
    const v = buffer.readUInt32BE(pos);
    pos += 4;
    return v / 2 ** 32; // [0, 1)
  };
}
