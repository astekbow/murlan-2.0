import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryClubRepository } from './clubRepository.ts';
import { ClubService, ClubError } from './clubService.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const clubs = new ClubService(new InMemoryClubRepository(), users);
  const a = await users.create({ username: 'Anila', email: 'a@a.com', passwordHash: 'h' });
  const b = await users.create({ username: 'Bekim', email: 'b@b.com', passwordHash: 'h' });
  const c = await users.create({ username: 'Drita', email: 'c@c.com', passwordHash: 'h' });
  return { clubs, a, b, c };
}

test('create seats the founder; join adds a member; getMyClub reflects it', async () => {
  const { clubs, a, b } = await setup();
  const club = await clubs.create(a.id, 'Murlan Masters', 'MUR');
  assert.equal(club.tag, 'MUR');
  assert.equal(club.memberCount, 1);
  assert.equal(club.members[0]!.role, 'founder');
  assert.equal(club.members[0]!.username, 'Anila');

  const joined = await clubs.join(b.id, club.id);
  assert.equal(joined.memberCount, 2);
  const mine = await clubs.getMyClub(b.id);
  assert.equal(mine!.id, club.id);
  assert.equal(mine!.members.find((m) => m.userId === b.id)!.role, 'member');
});

test('a player is in at most one club; duplicate tag rejected', async () => {
  const { clubs, a, b } = await setup();
  await clubs.create(a.id, 'Club One', 'ONE');
  await assert.rejects(clubs.create(a.id, 'Another', 'TWO'), (e) => e instanceof ClubError && e.code === 'already_in_club');
  await assert.rejects(clubs.create(b.id, 'Dupe', 'ONE'), (e) => e instanceof ClubError && e.code === 'tag_taken');
  const c2 = await clubs.create(b.id, 'Club Two', 'TWO');
  await assert.rejects(clubs.join(a.id, c2.id), (e) => e instanceof ClubError && e.code === 'already_in_club');
});

test('founder leaving promotes the oldest remaining member; emptying deletes the club', async () => {
  const { clubs, a, b, c } = await setup();
  const club = await clubs.create(a.id, 'Promote Test', 'PRM');
  await clubs.join(b.id, club.id); // b joins first
  await new Promise((r) => setTimeout(r, 3)); // ensure a strictly-later joinedAt
  await clubs.join(c.id, club.id); // then c

  await clubs.leave(a.id); // founder leaves → b (oldest remaining) becomes founder
  const after = await clubs.getClub(club.id);
  assert.equal(after!.founderId, b.id);
  assert.equal(after!.members.find((m) => m.userId === b.id)!.role, 'founder');
  assert.equal(after!.memberCount, 2);

  await clubs.leave(b.id);
  await clubs.leave(c.id); // last to leave → club disbands
  assert.equal(await clubs.getClub(club.id), null);
});

test('leave without a club errors; listClubs surfaces member counts', async () => {
  const { clubs, a, b } = await setup();
  await assert.rejects(clubs.leave(a.id), (e) => e instanceof ClubError && e.code === 'not_in_club');
  const club = await clubs.create(a.id, 'Listed', 'LST');
  await clubs.join(b.id, club.id);
  const list = await clubs.listClubs();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.memberCount, 2);
});

// authz-4: a PRIVATE club must 404 for a non-member, and its joinCode must never
// reach a non-member (anyone with the id could otherwise joinByCode it).
test('private club: hidden + joinCode withheld from non-members; visible to members', async () => {
  const { clubs, a, b } = await setup();
  const club = await clubs.create(a.id, 'Secret Society', 'SEC', true); // private
  assert.equal(club.private, true);
  assert.ok(club.joinCode, 'founder (a member) sees the joinCode');

  // A non-member is 404'd whether or not they pass their id.
  assert.equal(await clubs.getClub(club.id), null);
  assert.equal(await clubs.getClub(club.id, b.id), null);

  // The founder (a member) sees the full detail incl. the joinCode.
  const asFounder = await clubs.getClub(club.id, a.id);
  assert.ok(asFounder);
  assert.equal(asFounder!.joinCode, club.joinCode);

  // After joining by code, b is a member → sees it; the joinCode is now exposed to them.
  await clubs.joinByCode(b.id, club.joinCode!);
  const asMember = await clubs.getClub(club.id, b.id);
  assert.ok(asMember);
  assert.equal(asMember!.joinCode, club.joinCode);
});

test('public club: joinCode is null and detail is visible to a non-member', async () => {
  const { clubs, a, b } = await setup();
  const club = await clubs.create(a.id, 'Open Club', 'OPN'); // public
  assert.equal(club.private, false);
  const view = await clubs.getClub(club.id, b.id); // non-member can view a public club
  assert.ok(view);
  assert.equal(view!.joinCode, null);
});
