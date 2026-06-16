import test from 'node:test';
import assert from 'node:assert/strict';
import { TronDepositVerifier, USDT_TRC20_CONTRACT } from './tronDeposit.ts';

const MY = 'TMyDepositAdd0000000000000000000000';
const TX = 'a'.repeat(64);

function stub(body: any, ok = true, status = 200) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => { calls.push(url); return { ok, status, async json() { return body; } }; };
  return { calls, fetchFn };
}

const transfer = (over: Record<string, unknown> = {}) => ({
  transaction_id: TX, to: MY, from: 'TSenderAddr', value: '30000000', // 30 USDT (6 decimals)
  token_info: { address: USDT_TRC20_CONTRACT, decimals: 6, symbol: 'USDT' }, ...over,
});

test('verifies a matching USDT transfer to our address → amountCents', async () => {
  const { fetchFn } = stub({ data: [transfer()] });
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.deepEqual(r, { ok: true, amountCents: 3000, from: 'TSenderAddr' });
});

test('rejects a malformed TxID before any network call', async () => {
  const { calls, fetchFn } = stub({ data: [] });
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify('nope');
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('rejects when the TxID is not among transfers to our address', async () => {
  const { fetchFn } = stub({ data: [transfer({ transaction_id: 'b'.repeat(64) })] });
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.equal(r.ok, false);
  assert.match(r.error!, /nuk u gjet/i);
});

test('rejects a transfer to a different recipient', async () => {
  const { fetchFn } = stub({ data: [transfer({ to: 'TSomeoneElse' })] });
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.equal(r.ok, false);
});

test('passes the API key header when provided', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchFn = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, async json() { return { data: [transfer()] }; } }; };
  await new TronDepositVerifier({ depositAddress: MY, apiKey: 'KEY9', fetchFn }).verify(TX);
  assert.equal(calls[0]!.init.headers['TRON-PRO-API-KEY'], 'KEY9');
});

test('non-ok TronGrid response → error, never throws', async () => {
  const { fetchFn } = stub({}, false, 503);
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn, retryBaseMs: 0 }).verify(TX);
  assert.equal(r.ok, false);
  assert.match(r.error!, /503/);
});

test('WEB-7: retries a transient 503 then succeeds on the next attempt', async () => {
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    if (n < 3) return { ok: false, status: 503, async json() { return {}; } }; // flaky twice
    return { ok: true, status: 200, async json() { return { data: [transfer()] }; } }; // then OK
  };
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn, retryBaseMs: 0 }).verify(TX);
  assert.deepEqual(r, { ok: true, amountCents: 3000, from: 'TSenderAddr' });
  assert.equal(n, 3); // two failures + one success
});

test('WEB-7: retries a thrown network error, then gives up gracefully after the cap (never throws)', async () => {
  let n = 0;
  const fetchFn = async () => { n += 1; throw new Error('ECONNRESET'); };
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn, retryBaseMs: 0 }).verify(TX);
  assert.equal(r.ok, false);
  assert.equal(n, 3); // capped at 3 attempts
});

test('WEB-7: does NOT retry a definite 4xx (e.g. 404) — a missing tx is final', async () => {
  let n = 0;
  const fetchFn = async () => { n += 1; return { ok: false, status: 404, async json() { return {}; } }; };
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn, retryBaseMs: 0 }).verify(TX);
  assert.equal(r.ok, false);
  assert.equal(n, 1); // single attempt — no wasteful retries on a final answer
});

test('WEB-7: usdtBalanceCents retries a transient 5xx then returns the balance', async () => {
  // A real, checksum-valid base58 address (the fake MY can't be ABI-encoded).
  const ADDR = 'TUcsKWoZcF1mje96yMSG6NwzMvpJeo7pR6';
  let n = 0;
  // balanceOf(10 USDT) raw = 10_000000 = 0x989680
  const fetchFn = async () => {
    n += 1;
    if (n < 2) return { ok: false, status: 500, async json() { return {}; } };
    return { ok: true, status: 200, async json() { return { constant_result: ['989680'] }; } };
  };
  const bal = await new TronDepositVerifier({ depositAddress: ADDR, fetchFn, retryBaseMs: 0 }).usdtBalanceCents(ADDR);
  assert.equal(bal, 1000); // $10.00
  assert.equal(n, 2);
});

test('REJECTS a transfer with a missing/empty token contract (scam-token guard)', async () => {
  const { fetchFn } = stub({ data: [transfer({ token_info: { decimals: 0, symbol: 'SCAM' } })] }); // no .address
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.equal(r.ok, false);
  assert.match(r.error!, /USDT-TRC20/);
});

test('REJECTS a transfer from the wrong contract', async () => {
  const { fetchFn } = stub({ data: [transfer({ token_info: { address: 'TWrongContractXXXXXXXXXXXXXXXXXXXXX', decimals: 6 } })] });
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.equal(r.ok, false);
});

test('REJECTS invalid token decimals (negative / >18 / non-integer)', async () => {
  for (const decimals of [-6, 100, 6.5]) {
    const { fetchFn } = stub({ data: [transfer({ token_info: { address: USDT_TRC20_CONTRACT, decimals } })] });
    const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
    assert.equal(r.ok, false, `decimals=${decimals} must be rejected`);
  }
});

test('matches the TxID case-insensitively (TronGrid may return upper/mixed case)', async () => {
  const { fetchFn } = stub({ data: [transfer({ transaction_id: TX.toUpperCase() })] });
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.deepEqual(r, { ok: true, amountCents: 3000, from: 'TSenderAddr' });
});

test('uses integer math (no float-precision inflation)', async () => {
  // 999999.999999 USDT (6 decimals) → floor to 99,999,999 cents, NOT rounded up to 100,000,000.
  const { fetchFn } = stub({ data: [transfer({ value: '999999999999' })] });
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.equal(r.amountCents, 99_999_999);
});
