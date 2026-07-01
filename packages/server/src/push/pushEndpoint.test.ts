import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafePushEndpoint } from './pushProvider.ts';

test('isSafePushEndpoint accepts real https push services', () => {
  for (const url of [
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/xyz',
    'https://web.push.apple.com/QABC',
    'https://xyz.notify.windows.com/w/?token=abc',
  ]) {
    assert.equal(isSafePushEndpoint(url), true, url);
  }
});

test('isSafePushEndpoint blocks SSRF pivots (internal/loopback/metadata/non-https)', () => {
  for (const url of [
    'http://fcm.googleapis.com/fcm/send/abc',        // not https
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://169.254.169.254/latest/meta-data/',     // cloud metadata
    'https://10.0.0.5/x',
    'https://172.16.3.4/x',
    'https://192.168.1.10/x',
    'https://internal',                              // bare hostname
    'https://db.internal/x',
    'https://[::1]/x',
    'not-a-url',
  ]) {
    assert.equal(isSafePushEndpoint(url), false, url);
  }
});
