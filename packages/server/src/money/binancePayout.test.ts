import test from 'node:test';
import assert from 'node:assert/strict';
import { BinancePayoutProvider, BinanceWithdrawReader, WITHDRAW_ORDER_PREFIX } from './binancePayout.ts';

function stubFetch(handler: (url: string, init: any) => { ok: boolean; status: number; body: any }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchFn = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.ok, status: r.status, async text() { return JSON.stringify(r.body); }, async json() { return r.body; } };
  };
  return { calls, fetchFn };
}

const opts = (fetchFn: any) => ({ apiKey: 'KEY', apiSecret: 'SECRET', currency: 'usdttrc20', fetchFn, now: () => 1_700_000_000_000 });

test('binance payout signs the request and passes coin/network/address/amount/withdrawOrderId', async () => {
  const { calls, fetchFn } = stubFetch(() => ({ ok: true, status: 200, body: { id: 'W123' } }));
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_9', amountCents: 3000, address: 'TXabc' });
  assert.deepEqual(r, { ok: true, providerRef: 'W123' });
  assert.match(calls[0]!.url, /\/sapi\/v1\/capital\/withdraw\/apply$/);
  assert.equal(calls[0]!.init.headers['X-MBX-APIKEY'], 'KEY');
  const body = String(calls[0]!.init.body);
  assert.match(body, /coin=USDT/);
  assert.match(body, /network=TRX/);
  assert.match(body, /address=TXabc/);
  assert.match(body, /amount=30\.00/);
  assert.match(body, /withdrawOrderId=murlan_wd_9/); // idempotency (prefixed to namespace our payouts in Binance history)
  assert.match(body, /signature=[a-f0-9]{64}/); // HMAC-SHA256 hex appended
});

test('binance payout returns a DEFINITE failure on a non-duplicate 4xx (→ refund), never throws', async () => {
  const { fetchFn } = stubFetch(() => ({ ok: false, status: 400, body: { code: -1, msg: 'bad address' } }));
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'bad' });
  assert.equal(r.ok, false);
  assert.equal(r.duplicate, undefined);
  assert.equal(r.ambiguous, undefined); // a clean 4xx is DEFINITE → safe to refund
  assert.match(r.error!, /400/);
});

test('money-16: a DUPLICATE-order rejection is classified duplicate (→ mark paid, no refund)', async () => {
  const { fetchFn } = stubFetch(() => ({ ok: false, status: 400, body: { code: -4046, msg: 'withdrawOrderId already exists' } }));
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'TXabc' });
  assert.equal(r.ok, false);
  assert.equal(r.duplicate, true);
  assert.equal(r.ambiguous, undefined);
});

test('money-16: a DUPLICATE code on a 200 envelope is still duplicate', async () => {
  const { fetchFn } = stubFetch(() => ({ ok: true, status: 200, body: { code: -9000, msg: 'duplicate withdraw order' } }));
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'TXabc' });
  assert.equal(r.ok, false);
  assert.equal(r.duplicate, true);
});

test('money-16: a 5xx is AMBIGUOUS (maybe sent → NEVER refund)', async () => {
  const { fetchFn } = stubFetch(() => ({ ok: false, status: 503, body: { msg: 'busy' } }));
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'TXabc' });
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, true);
  assert.equal(r.duplicate, undefined);
});

test('money-16: a 429 is AMBIGUOUS (request reached Binance, outcome unknown)', async () => {
  const { fetchFn } = stubFetch(() => ({ ok: false, status: 429, body: { msg: 'rate' } }));
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'TXabc' });
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, true);
});

test('money-16: a network THROW is AMBIGUOUS (not a definite failure → no refund)', async () => {
  const fetchFn = async () => { throw new Error('ECONNRESET'); };
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'TXabc' });
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, true);
  assert.match(r.error!, /ambiguous/);
});

test('money-16: a SEND TIMEOUT (AbortController) is AMBIGUOUS, never a refund', async () => {
  // A fetch that respects the abort signal and rejects with an AbortError when aborted.
  const fetchFn = (_url: string, init: any) => new Promise<any>((_res, rej) => {
    const sig: AbortSignal | undefined = init?.signal;
    if (sig) sig.addEventListener('abort', () => { const e = new Error('aborted'); (e as any).name = 'AbortError'; rej(e); });
    // never resolve → only the abort fires
  });
  const r = await new BinancePayoutProvider({ apiKey: 'K', apiSecret: 'S', currency: 'usdttrc20', fetchFn: fetchFn as any, now: () => 1, timeoutMs: 20 }).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'TXabc' });
  assert.equal(r.ok, false);
  assert.equal(r.ambiguous, true);
  assert.match(r.error!, /timed out|ambiguous/);
});

test('binance payout rejects an unsupported currency', async () => {
  const { fetchFn } = stubFetch(() => ({ ok: true, status: 200, body: { id: 'x' } }));
  const r = await new BinancePayoutProvider({ apiKey: 'K', apiSecret: 'S', currency: 'dogecoin', fetchFn }).payout({ withdrawalId: 'w', amountCents: 100, address: 'a' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /unsupported/);
});

test('binance payout swallows a fetch rejection', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'w', amountCents: 100, address: 'a' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /binance error/);
});

test('WEB-7: a payout SEND is SINGLE-SHOT — a transient 503 is NOT retried (double-pay guard)', async () => {
  let n = 0;
  const { fetchFn } = stubFetch(() => { n += 1; return { ok: false, status: 503, body: { msg: 'busy' } }; });
  const r = await new BinancePayoutProvider(opts(fetchFn)).payout({ withdrawalId: 'wd_1', amountCents: 1000, address: 'TXabc' });
  assert.equal(r.ok, false);
  assert.equal(n, 1); // exactly one attempt — never resent
});

test('WEB-7: BinanceWithdrawReader.listRecent retries a transient 5xx then returns our prefixed rows', async () => {
  let n = 0;
  const fetchFn = async () => {
    n += 1;
    if (n < 2) return { ok: false, status: 500, async text() { return ''; }, async json() { return []; } };
    return { ok: true, status: 200, async text() { return ''; }, async json() { return [{ withdrawOrderId: WITHDRAW_ORDER_PREFIX + 'wd_7', status: 6, amount: '30' }]; } };
  };
  const reader = new BinanceWithdrawReader({ apiKey: 'K', apiSecret: 'S', fetchFn, now: () => 1, retryBaseMs: 0 });
  const out = await reader.listRecent(0);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.withdrawOrderId, 'wd_7'); // prefix stripped → bare id
  assert.equal(out[0]!.amountCents, 3000);
  assert.equal(n, 2);
});
