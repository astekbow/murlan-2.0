import test from 'node:test';
import assert from 'node:assert/strict';
import { MockPaymentProvider } from './paymentProvider.ts';

test('createDeposit returns a unique providerRef and pay address', async () => {
  const p = new MockPaymentProvider('secret');
  const a = await p.createDeposit({ userId: 'u1', amountCents: 5000 });
  const b = await p.createDeposit({ userId: 'u1', amountCents: 5000 });
  assert.notEqual(a.providerRef, b.providerRef);
  assert.match(a.payAddress, /^mock:\/\/pay\//);
  assert.equal(a.amountCents, 5000);
});

test('verifyWebhook accepts a correctly signed confirmed deposit', () => {
  const p = new MockPaymentProvider('secret');
  const body = JSON.stringify({ providerRef: 'mock_1', userId: 'u1', amountCents: 5000, currency: 'USDT', status: 'confirmed' });
  const sig = p.sign(body);
  const result = p.verifyWebhook(body, sig);
  assert.ok(result);
  assert.equal(result!.providerRef, 'mock_1');
  assert.equal(result!.userId, 'u1');
  assert.equal(result!.amountCents, 5000);
  assert.equal(result!.confirmed, true);
});

test('verifyWebhook rejects a bad/missing signature', () => {
  const p = new MockPaymentProvider('secret');
  const body = JSON.stringify({ providerRef: 'mock_1', userId: 'u1', amountCents: 5000 });
  assert.equal(p.verifyWebhook(body, 'deadbeef'), null);
  assert.equal(p.verifyWebhook(body, undefined), null);
  // signature from a DIFFERENT secret must not validate
  assert.equal(p.verifyWebhook(body, new MockPaymentProvider('other').sign(body)), null);
});

test('verifyWebhook rejects malformed or non-positive amounts', () => {
  const p = new MockPaymentProvider('secret');
  const bad = JSON.stringify({ providerRef: 'x', userId: 'u1', amountCents: -1 });
  assert.equal(p.verifyWebhook(bad, p.sign(bad)), null);
  const notJson = 'not json';
  assert.equal(p.verifyWebhook(notJson, p.sign(notJson)), null);
});
