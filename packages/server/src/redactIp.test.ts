import test from 'node:test';
import assert from 'node:assert/strict';
import { redactIp } from './app.ts';

test('redactIp: IPv4 keeps the /24 network, zeroes the host octet (no full IP leaks to logs)', () => {
  assert.equal(redactIp('203.0.113.42'), '203.0.113.0');
  assert.equal(redactIp('10.20.30.40'), '10.20.30.0');
  // the last octet (the individuating part) must never survive
  assert.ok(!redactIp('203.0.113.42').endsWith('.42'));
});

test('redactIp: IPv6 keeps only the first 3 groups (/48)', () => {
  assert.equal(redactIp('2001:db8:abcd:1234:5678:9abc:def0:1234'), '2001:db8:abcd::/48');
});

test('redactIp: missing/odd input never throws and never returns a usable identifier', () => {
  assert.equal(redactIp(undefined), 'unknown');
  assert.equal(redactIp(null), 'unknown');
  assert.equal(redactIp(''), 'unknown');
});
