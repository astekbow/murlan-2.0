// Password hashing — Argon2id via @node-rs/argon2 (prebuilt binaries, no native
// build step). Defaults are the library's OWASP-aligned Argon2id parameters.

import { hash, verify } from '@node-rs/argon2';

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    // A malformed/legacy hash should read as "does not match", not crash login.
    return false;
  }
}
