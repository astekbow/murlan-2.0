import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NowPaymentsProvider } from './nowPaymentsProvider.ts';

const SECRET = 'ipn_secret_under_test';
const provider = new NowPaymentsProvider('api_key', SECRET, 'https://play.example.com');

// Mirror NOWPayments' signing: HMAC-SHA512 over the KEY-SORTED JSON.
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a: any, k) => { a[k] = sortKeys(v[k]); return a; }, {});
  return v;
}
const sign = (payload: object) => createHmac('sha512', SECRET).update(JSON.stringify(sortKeys(payload))).digest('hex');

test('verifyWebhook accepts a correctly-signed finished IPN and maps the fields', () => {
  const payload = { payment_id: 123, invoice_id: 456, order_id: 'user-abc', payment_status: 'finished', price_amount: 25, price_currency: 'usd', actually_paid: 0.0004 };
  const r = provider.verifyWebhook(JSON.stringify(payload), sign(payload));
  assert.ok(r);
  assert.equal(r!.providerRef, '456'); // invoice id (matches the createDeposit intent)
  assert.equal(r!.userId, 'user-abc'); // order_id → our userId
  assert.equal(r!.amountCents, 2500);  // price_amount USD → cents
  assert.equal(r!.confirmed, true);
});

test('only "finished" confirms — every other status acks without crediting', () => {
  for (const status of ['waiting', 'confirming', 'confirmed', 'sending', 'partially_paid', 'failed', 'expired']) {
    const payload = { invoice_id: 1, order_id: 'u', payment_status: status, price_amount: 10, price_currency: 'usd' };
    const r = provider.verifyWebhook(JSON.stringify(payload), sign(payload));
    assert.ok(r, `parsed ${status}`);
    assert.equal(r!.confirmed, false, `${status} must not confirm`);
  }
});

test('rejects a missing / wrong / tampered signature (no minting on a leaked body)', () => {
  const payload = { invoice_id: 1, order_id: 'u', payment_status: 'finished', price_amount: 10, price_currency: 'usd' };
  const raw = JSON.stringify(payload);
  assert.equal(provider.verifyWebhook(raw, undefined), null);
  assert.equal(provider.verifyWebhook(raw, 'deadbeef'), null);
  // Valid signature for the ORIGINAL body, but the body was tampered (amount inflated)
  // → the provider re-derives the HMAC over the received body and it no longer matches.
  const tampered = JSON.stringify({ ...payload, price_amount: 9999 });
  assert.equal(provider.verifyWebhook(tampered, sign(payload)), null);
});

test('key order in the raw body does not matter (signature is over sorted keys)', () => {
  const a = { order_id: 'u', invoice_id: 7, payment_status: 'finished', price_amount: 5, price_currency: 'usd' };
  // Same data, different JSON key order on the wire:
  const rawDifferentOrder = '{"price_amount":5,"order_id":"u","price_currency":"usd","payment_status":"finished","invoice_id":7}';
  const r = provider.verifyWebhook(rawDifferentOrder, sign(a));
  assert.ok(r);
  assert.equal(r!.confirmed, true);
  assert.equal(r!.providerRef, '7');
});
