import test from 'node:test';
import assert from 'node:assert/strict';
import { totp, base32Decode } from './totp.ts';

// RFC 6238 Appendix B test vector: ASCII secret "12345678901234567890" (SHA-1).
// Its base32 encoding is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32Decode recovers the RFC ASCII secret', () => {
  assert.equal(base32Decode(RFC_SECRET_B32).toString('utf8'), '12345678901234567890');
});

test('totp matches RFC 6238 8-digit vectors (SHA-1, 30s)', () => {
  // T=59s → 94287082 ; T=1111111109s → 07081804 (RFC 6238 Appendix B, SHA-1).
  assert.equal(totp(RFC_SECRET_B32, 59_000, 30, 8), '94287082');
  assert.equal(totp(RFC_SECRET_B32, 1_111_111_109_000, 30, 8), '07081804');
});

test('totp produces a 6-digit code by default', () => {
  const code = totp(RFC_SECRET_B32, 59_000);
  assert.match(code, /^\d{6}$/);
  assert.equal(code, '287082'); // last 6 of 94287082
});
