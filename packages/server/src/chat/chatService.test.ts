import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryClubRepository } from '../social/clubRepository.ts';
import { ClubService } from '../social/clubService.ts';
import { InMemoryChatRepository } from './chatRepository.ts';
import { ChatService, sanitizeChat } from './chatService.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const clubsRepo = new InMemoryClubRepository();
  const clubs = new ClubService(clubsRepo, users);
  const chatRepo = new InMemoryChatRepository();
  let nowMs = 1_000_000;
  const chat = new ChatService(chatRepo, clubs, () => nowMs);
  const founder = await users.create({ username: 'founder', email: 'f@f.com', passwordHash: 'h' });
  const member = await users.create({ username: 'member', email: 'm@m.com', passwordHash: 'h' });
  const outsider = await users.create({ username: 'outsider', email: 'o@o.com', passwordHash: 'h' });
  const club = await clubs.create(founder.id, 'Masters', 'MUR');
  await clubs.join(member.id, club.id);
  return { chat, clubs, club, founder, member, outsider, setNow: (ms: number) => { nowMs = ms; } };
}

test('sanitizeChat trims, caps length, and masks blocklisted words', () => {
  assert.equal(sanitizeChat('   hi   there  '), 'hi there');
  assert.equal(sanitizeChat('you are a shit player'), 'you are a **** player');
  assert.equal(sanitizeChat('a'.repeat(500)).length, 280);
});

test('a member can send to their club; an outsider cannot', async () => {
  const { chat, club, member, outsider } = await setup();
  const ok = await chat.send(member.id, 'member', 'mirëmëngjes klub!');
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.message.clubId, club.id); assert.equal(ok.message.text, 'mirëmëngjes klub!'); }

  const no = await chat.send(outsider.id, 'outsider', 'hello');
  assert.deepEqual(no, { ok: false, code: 'no_club' });
});

test('history is members-only', async () => {
  const { chat, club, founder, member, outsider } = await setup();
  await chat.send(member.id, 'member', 'one');
  await chat.send(founder.id, 'founder', 'two');
  const hist = await chat.history(member.id, club.id);
  assert.equal(hist?.length, 2);
  assert.deepEqual(hist?.map((m) => m.text), ['one', 'two']); // chronological
  assert.equal(await chat.history(outsider.id, club.id), null); // not a member
});

test('a founder can mute a member, which shadow-drops their messages', async () => {
  const { chat, member, founder } = await setup();
  const muteRes = await chat.founderMute(founder.id, member.id, 60_000, 'spam');
  assert.equal(muteRes.ok, true);
  assert.deepEqual(await chat.send(member.id, 'member', 'still here?'), { ok: false, code: 'muted' });
  // The founder is unaffected.
  assert.equal((await chat.send(founder.id, 'founder', 'rules!')).ok, true);
});

test('only a founder may mute, never a regular member or self', async () => {
  const { chat, member, founder } = await setup();
  assert.equal((await chat.founderMute(member.id, founder.id, 60_000, '')).code, 'forbidden'); // member can't mute
  assert.equal((await chat.founderMute(founder.id, founder.id, 60_000, '')).code, 'self');     // no self-mute
});

test('an expired mute lets the user speak again', async () => {
  const { chat, member, founder, setNow } = await setup();
  await chat.founderMute(founder.id, member.id, 60_000, ''); // muted until 1_060_000
  setNow(2_000_000); // past expiry
  assert.equal((await chat.send(member.id, 'member', 'back!')).ok, true);
});

test('report requires the reporter to share the message’s club', async () => {
  const { chat, member, outsider } = await setup();
  const sent = await chat.send(member.id, 'member', 'report me');
  assert.ok(sent.ok);
  const msgId = sent.ok ? sent.message.id : '';
  assert.equal((await chat.report(outsider.id, msgId, 'abuse')).code, 'forbidden');
  assert.equal((await chat.report(member.id, msgId, 'abuse')).ok, true);
  assert.equal((await chat.listReports()).length, 1);
});
