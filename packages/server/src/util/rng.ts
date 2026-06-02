// Randomness helpers. The real deal must never use Math.random (spec §8).
// Until the provably-fair commit-reveal scheme lands (Phase 7), shuffles use a
// cryptographically secure RNG. Phase 7 replaces `cryptoRng` with an
// HMAC-SHA256(serverSeed, clientSeed:nonce) PRNG fed to engine.shuffle.

import { randomBytes } from 'node:crypto';

/** A float in [0, 1) backed by crypto-strong bytes (drop-in for engine.shuffle). */
export function cryptoRng(): () => number {
  return () => {
    // 6 random bytes -> 48 bits of entropy, divided into the unit interval.
    const buf = randomBytes(6);
    let value = 0;
    for (let i = 0; i < 6; i++) value = value * 256 + buf[i];
    return value / 2 ** 48;
  };
}
