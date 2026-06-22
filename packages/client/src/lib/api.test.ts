import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { walletApi, adminApi, ApiError, registerSessionHandlers } from './api.ts';

// The REST layer that moves money (deposit/withdraw/admin adjust/approve/reject). We mock
// global fetch and assert the exact request it builds (path/method/auth/body) + its error
// + 401-refresh-retry behavior. This is the request-building/token/error surface that
// actually drives money flows — previously only the pure money formatter was tested.

type MockRes = { ok: boolean; status: number; body?: unknown };
let queue: MockRes[] = [];
let calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];

beforeEach(() => {
  queue = [];
  calls = [];
  global.fetch = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    const r = queue.shift() ?? { ok: true, status: 200, body: {} };
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {} } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => { vi.restoreAllMocks(); });

const ok = (body: unknown) => queue.push({ ok: true, status: 200, body });
const fail = (status: number, code?: string) => queue.push({ ok: false, status, body: code ? { error: { code } } : {} });
const last = () => calls[calls.length - 1]!;

test('walletApi.withdraw POSTs amount+destination with the bearer token', async () => {
  ok({ withdrawal: { id: 'w1' } });
  await walletApi.withdraw('tok', 5000, 'TDestAddr');
  expect(calls[0]!.url).toBe('/api/wallet/withdraw');
  expect(calls[0]!.method).toBe('POST');
  expect(calls[0]!.headers.authorization).toBe('Bearer tok');
  expect(calls[0]!.headers['content-type']).toBe('application/json');
  expect(calls[0]!.body).toEqual({ amountCents: 5000, destination: 'TDestAddr' });
});

test('walletApi.deposit + submitDepositTxid hit the right routes', async () => {
  ok({ id: 'intent1' });
  await walletApi.deposit('tok', 1500);
  expect(calls[0]!.url).toBe('/api/wallet/deposit');
  expect(calls[0]!.body).toEqual({ amountCents: 1500 });

  ok({ ok: true, amountCents: 1500, balanceCents: 1500 });
  await walletApi.submitDepositTxid('tok', 'abc123');
  expect(last().url).toBe('/api/wallet/deposit/txid');
  expect(last().body).toEqual({ txId: 'abc123' });
});

test('a GET (balance) sends no body + no content-type but keeps the bearer', async () => {
  ok({ balanceCents: 999 });
  const res = await walletApi.balance('tok');
  expect(res.balanceCents).toBe(999);
  expect(calls[0]!.method).toBe('GET');
  expect(calls[0]!.body).toBeUndefined();
  expect(calls[0]!.headers['content-type']).toBeUndefined();
  expect(calls[0]!.headers.authorization).toBe('Bearer tok');
});

test('adminApi.adjust POSTs delta+reason to the user adjust route', async () => {
  ok({ balanceCents: 100 });
  await adminApi.adjust('tok', 'u1', -250, 'penalty');
  expect(calls[0]!.url).toBe('/api/admin/users/u1/adjust');
  expect(calls[0]!.method).toBe('POST');
  expect(calls[0]!.body).toEqual({ deltaCents: -250, reason: 'penalty' });
});

test('adminApi.approveWithdrawal / rejectWithdrawal hit the right routes', async () => {
  ok({});
  await adminApi.approveWithdrawal('tok', 'w9');
  expect(calls[0]!.url).toBe('/api/admin/withdrawals/w9/approve');
  expect(calls[0]!.method).toBe('POST');

  ok({});
  await adminApi.rejectWithdrawal('tok', 'w9', 'suspected fraud');
  expect(last().url).toBe('/api/admin/withdrawals/w9/reject');
  expect(last().body).toEqual({ reason: 'suspected fraud' });
});

test('a non-ok response throws ApiError carrying the server code + status', async () => {
  fail(402, 'insufficient_funds');
  await expect(walletApi.withdraw('t', 1, 'x')).rejects.toMatchObject({ code: 'insufficient_funds', status: 402 });
});

test('a 429 maps to the rate_limited code', async () => {
  fail(429);
  const e = await walletApi.balance('t').then(() => null).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ApiError);
  expect((e as ApiError).code).toBe('rate_limited');
  expect((e as ApiError).status).toBe(429);
});

test('a network failure throws ApiError(network, 0)', async () => {
  (global.fetch as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(new Error('down'));
  await expect(walletApi.balance('t')).rejects.toMatchObject({ code: 'network', status: 0 });
});

test('a 401 on an authed call refreshes once and retries with the NEW token', async () => {
  const onToken = vi.fn();
  registerSessionHandlers({ onToken, onLost: vi.fn() });
  fail(401, 'token_expired'); // #1 GET /wallet → 401
  ok({ accessToken: 'fresh', refreshToken: 'r', user: {} }); // #2 POST /auth/refresh → 200
  ok({ balanceCents: 42 }); // #3 retried GET /wallet → 200
  const res = await walletApi.balance('stale');
  expect(res.balanceCents).toBe(42);
  expect(onToken).toHaveBeenCalledWith('fresh');
  expect(calls.some((c) => c.url === '/api/auth/refresh' && c.method === 'POST')).toBe(true);
  expect(last().url).toBe('/api/wallet');
  expect(last().headers.authorization).toBe('Bearer fresh'); // retried with the refreshed token
});

test('if the refresh also fails, it signals session lost + throws session_expired', async () => {
  const onLost = vi.fn();
  registerSessionHandlers({ onToken: vi.fn(), onLost });
  fail(401, 'token_expired'); // #1 → 401
  fail(401); // #2 refresh → 401 → refresh rejects
  await expect(walletApi.balance('stale')).rejects.toMatchObject({ code: 'session_expired', status: 401 });
  expect(onLost).toHaveBeenCalled();
});

test('an UNauthenticated 401 does NOT trigger a refresh (no token)', async () => {
  fail(401, 'unauthorized');
  await expect(walletApi.balance('')).rejects.toMatchObject({ status: 401 });
  // only the one call — no /auth/refresh
  expect(calls.filter((c) => c.url === '/api/auth/refresh')).toHaveLength(0);
});
