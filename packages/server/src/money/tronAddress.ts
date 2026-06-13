// TRON (base58check) address validation. A valid mainnet address is 34 chars,
// starts with 'T', and base58-decodes to 25 bytes: a 0x41 prefix + 20-byte body
// + a 4-byte checksum = first 4 bytes of sha256(sha256(prefix+body)). Validating
// the CHECKSUM (not just the shape) catches typos that would otherwise burn funds.

import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode base58 → bytes, or null on an invalid character. */
function base58Decode(s: string): Uint8Array | null {
  const bytes: number[] = [0];
  for (const ch of s) {
    const value = ALPHABET.indexOf(ch);
    if (value === -1) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < s.length && s[k] === '1'; k++) bytes.push(0); // leading zeros
  bytes.reverse();
  return Uint8Array.from(bytes);
}

/** True only for a well-formed mainnet TRON address with a valid checksum. */
export function isValidTronAddress(addr: unknown): boolean {
  if (typeof addr !== 'string' || addr.length !== 34 || addr[0] !== 'T') return false;
  const decoded = base58Decode(addr);
  if (!decoded || decoded.length !== 25 || decoded[0] !== 0x41) return false;
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21, 25);
  const h = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest();
  for (let i = 0; i < 4; i++) if (checksum[i] !== h[i]) return false;
  return true;
}
