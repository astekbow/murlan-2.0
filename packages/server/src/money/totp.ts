// RFC 6238 TOTP (time-based one-time password) — used to generate the 2FA code
// NOWPayments requires to verify a payout, from the account's authenticator
// secret. SHA-1, 30s step, 6 digits (the standard Google Authenticator setup).
// Pure + deterministic (time passed in) so it's unit-testable against the RFC
// test vectors.

import { createHmac } from 'node:crypto';

/** Decode a base32 (RFC 4648) secret — the format authenticator apps show. */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue; // skip stray chars
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Generate a TOTP code for `secretBase32` at epoch-ms `atMs`. Defaults match a
 * standard authenticator (30s step, 6 digits, SHA-1).
 */
export function totp(secretBase32: string, atMs: number, step = 30, digits = 6): string {
  const key = base32Decode(secretBase32);
  let counter = Math.floor(atMs / 1000 / step);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}
