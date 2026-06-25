import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDms } from './dmRepository.ts';
import { DmService } from './dmService.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import type { FriendsService } from './friendsService.ts';

const friendsStub = (areFriends: boolean) => ({ areFriends: async () => areFriends }) as unknown as FriendsService;

test('DM: friends-only send; conversation marks read; unread counts', async () => {
  const users = new InMemoryUserRepository();
  const a = await users.create({ username: 'A', email: 'a@x.com', passwordHash: 'h' });
  const b = await users.create({ username: 'B', email: 'b@x.com', passwordHash: 'h' });
  const dms = new InMemoryDms();

  // Not friends → refused.
  assert.equal(await new DmService(dms, friendsStub(false), users).send(a.id, b.id, 'hi'), null);

  const svc = new DmService(dms, friendsStub(true), users);
  assert.equal(await svc.send(a.id, b.id, '   '), null);       // blank refused
  assert.equal(await svc.send(a.id, a.id, 'self'), null);      // no self-DM
  assert.ok(await svc.send(a.id, b.id, 'hello'));
  assert.ok(await svc.send(a.id, b.id, 'you there?'));

  // B has 2 unread from A.
  assert.deepEqual(await svc.unread(b.id), { [a.id]: 2 });

  // Opening the conversation returns both (oldest→newest) and marks them read.
  const convo = await svc.conversation(b.id, a.id, 1, 50);
  assert.deepEqual(convo?.map((m) => m.text), ['hello', 'you there?']);
  assert.deepEqual(await svc.unread(b.id), {});

  // The notifier fires on send (real-time push).
  let pushed = 0;
  svc.setNotifier(() => { pushed += 1; });
  await svc.send(b.id, a.id, 'reply');
  assert.equal(pushed, 1);
});
