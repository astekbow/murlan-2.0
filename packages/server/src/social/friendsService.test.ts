import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryFriends } from './friendsRepository.ts';
import { Presence } from '../realtime/presence.ts';
import { FriendsService, FriendsError } from './friendsService.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const presence = new Presence();
  const friends = new FriendsService(users, new InMemoryFriends(), presence);
  const a = await users.create({ username: 'alice', email: 'a@x.com', passwordHash: 'h' });
  const b = await users.create({ username: 'bob', email: 'b@x.com', passwordHash: 'h' });
  return { users, presence, friends, a, b };
}

test('request creates a directed pending edge (outgoing for sender, incoming for target)', async () => {
  const { friends, a, b } = await setup();
  await friends.requestByUsername(a.id, 'bob');
  const aList = await friends.list(a.id);
  assert.equal(aList.length, 1);
  assert.equal(aList[0]!.direction, 'outgoing');
  assert.equal(aList[0]!.user.username, 'bob');
  const bList = await friends.list(b.id);
  assert.equal(bList[0]!.direction, 'incoming');
});

test('accept makes a mutual friendship; areFriends becomes true', async () => {
  const { friends, a, b } = await setup();
  const edge = await friends.requestByUsername(a.id, 'bob');
  assert.ok(edge); // 'bob' exists → a real request row
  assert.equal(await friends.areFriends(a.id, b.id), false); // pending != friends
  const res = await friends.respond(b.id, edge.id, true);
  assert.ok(res);
  assert.equal(await friends.areFriends(a.id, b.id), true);
  assert.equal((await friends.list(a.id))[0]!.direction, 'friends');
});

test('only the addressee can accept; the requester accepting is a no-op (null)', async () => {
  const { friends, a } = await setup();
  const edge = await friends.requestByUsername(a.id, 'bob');
  assert.ok(edge);
  assert.equal(await friends.respond(a.id, edge.id, true), null);
});

test('decline removes the request', async () => {
  const { friends, a, b } = await setup();
  const edge = await friends.requestByUsername(a.id, 'bob');
  assert.ok(edge);
  await friends.respond(b.id, edge.id, false);
  assert.equal((await friends.list(a.id)).length, 0);
});

test('requestByUsername rejects self but is enumeration-safe (null) for unknown users', async () => {
  const { friends, a } = await setup();
  await assert.rejects(friends.requestByUsername(a.id, 'alice'), (e: unknown) => e instanceof FriendsError && e.code === 'self');
  // Unknown username → null (NOT a distinct error), so existence can't be enumerated.
  assert.equal(await friends.requestByUsername(a.id, 'ghost'), null);
});

test('block: severs the friendship, suppresses requests, and is one-directional (hidden from the blocked user)', async () => {
  const { friends, a, b } = await setup();
  await friends.block(a.id, b.id);
  assert.equal(await friends.areFriends(a.id, b.id), false);

  // The blocked user's request back is silently dropped — returns null (NOT a distinct
  // error), so it reveals neither that 'alice' exists nor that a block is in place.
  assert.equal(await friends.requestByUsername(b.id, 'alice'), null);

  // The blocker sees the block (to be able to unblock); the blocked user sees nothing.
  assert.equal((await friends.list(a.id)).find((f) => f.user.id === b.id)?.direction, 'blocked');
  assert.equal((await friends.list(b.id)).length, 0);
});

test('unblock restores the ability to send a request', async () => {
  const { friends, a, b } = await setup();
  await friends.block(a.id, b.id);
  await friends.unblock(a.id, b.id);
  await assert.doesNotReject(friends.requestByUsername(a.id, 'bob'));
});

test('list reflects live presence (online dot)', async () => {
  const { friends, presence, a, b } = await setup();
  const edge = await friends.requestByUsername(a.id, 'bob');
  assert.ok(edge);
  await friends.respond(b.id, edge.id, true);
  presence.add(b.id);
  assert.equal((await friends.list(a.id))[0]!.online, true);
  presence.remove(b.id);
  assert.equal((await friends.list(a.id))[0]!.online, false);
});
