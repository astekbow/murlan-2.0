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
  const r = await new TronDepositVerifier({ depositAddress: MY, fetchFn }).verify(TX);
  assert.equal(r.ok, false);
  assert.match(r.error!, /503/);
});
