// Password hashing — Argon2id via @node-rs/argon2 (prebuilt binaries, no native
// build step). Params are pinned to OWASP's Argon2id minimum (m=19 MiB, t=2, p=1) —
// the library's DEFAULT memoryCost is only 4 MiB, far below OWASP, so we set it
// explicitly. verify() reads params from the stored hash, so older 4 MiB hashes still
// verify; only NEW hashes use the stronger cost.

import { hash, verify } from '@node-rs/argon2';

export function hashPassword(plain: string): Promise<string> {
  // @node-rs/argon2's default variant is Argon2id; we only raise the cost to OWASP's
  // minimum (the library default memoryCost is 4 MiB). Variant left implicit because the
  // `Algorithm` const enum can't be imported under verbatimModuleSyntax.
  return hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    // A malformed/legacy hash should read as "does not match", not crash login.
    return false;
  }
}
