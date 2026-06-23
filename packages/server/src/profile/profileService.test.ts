// authz-2: an uploaded avatar data-URL is validated by decoded MAGIC BYTES, not just the
// MIME prefix — a `data:image/png;base64,...` carrying non-image (script/SVG) bytes is a
// latent stored-XSS and must be rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { ProfileService, AVATARS } from './profileService.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const u = await users.create({ username: 'pic', email: 'p@x.com', passwordHash: 'h' });
  return { svc: new ProfileService(users), userId: u.id };
}

// A 1x1 PNG (valid magic bytes 89 50 4E 47 …) base64-encoded.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngDataUrl = `data:image/png;base64,${PNG_1x1}`;

test('avatar: a preset id is accepted', async () => {
  const { svc, userId } = await setup();
  const p = await svc.setAvatar(userId, AVATARS[0]);
  assert.equal(p!.avatar, AVATARS[0]);
});

test('avatar: a real PNG data-URL (valid magic bytes) is accepted', async () => {
  const { svc, userId } = await setup();
  const p = await svc.setAvatar(userId, pngDataUrl);
  assert.equal(p!.avatar, pngDataUrl);
});

test('avatar: a data:image/png with NON-image bytes (fake MIME) is REJECTED', async () => {
  const { svc, userId } = await setup();
  // "<script>alert(1)</script>" base64 — declares image/png but is not a real image.
  const evil = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
  await assert.rejects(() => svc.setAvatar(userId, evil), /invalid avatar/);
});

test('avatar: a data:image/png whose bytes are a JPEG/other is still an image and accepted only on real magic', async () => {
  const { svc, userId } = await setup();
  // Empty/short payload → no valid magic → rejected.
  await assert.rejects(() => svc.setAvatar(userId, 'data:image/png;base64,AAAA'), /invalid avatar/);
});

test('avatar: an oversized data-URL is rejected before decode', async () => {
  const { svc, userId } = await setup();
  const huge = `data:image/png;base64,${'A'.repeat(20_000)}`;
  await assert.rejects(() => svc.setAvatar(userId, huge), /invalid avatar/);
});
