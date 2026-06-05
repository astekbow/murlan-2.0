import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemorySeasonRepository } from './seasonRepository.ts';
import { RankedService } from './rankedService.ts';

async function setup() {
  const users = new InMemoryUserRepository();
  const seasons = new InMemorySeasonRepository();
  let clock = 1_000_000;
  const ranked = new RankedService(seasons, users, () => clock);
  const a = await users.create({ username: 'Anila', email: 'a@a.com', passwordHash: 'h' });
  const b = await users.create({ username: 'Bekim', email: 'b@b.com', passwordHash: 'h' });
  const c = await users.create({ username: 'Drita', email: 'c@c.com', passwordHash: 'h' });
  return { users, seasons, ranked, a, b, c, tick: () => { clock += 1000; } };
}

test('no active season ⇒ recording a match is a no-op and ranked reads as off', async () => {
  const { ranked, a, b } = await setup();
  assert.equal(await ranked.getActiveSeason(), null);
  const deltas = await ranked.recordMatchResult([{ userId: a.id, won: true }, { userId: b.id, won: false }]);
  assert.deepEqual(deltas, []);
  const me = await ranked.getUserRanked(a.id);
  assert.equal(me.season, null);
  assert.equal(me.rating, 1000);
  assert.equal((await ranked.leaderboard()).length, 0);
});

test('createSeason opens an active season; a rated match moves both players', async () => {
  const { ranked, a, b } = await setup();
  const season = await ranked.createSeason('Sezoni 1');
  assert.equal(season.number, 1);
  assert.equal(season.status, 'active');

  const deltas = await ranked.recordMatchResult([{ userId: a.id, won: true }, { userId: b.id, won: false }]);
  assert.equal(deltas.length, 2);
  const aDelta = deltas.find((d) => d.userId === a.id)!;
  assert.equal(aDelta.oldRating, 1000);
  assert.equal(aDelta.newRating, 1016);

  const aRanked = await ranked.getUserRanked(a.id);
  assert.equal(aRanked.rating, 1016);
  assert.equal(aRanked.peakRating, 1016);
  assert.equal(aRanked.games, 1);
  assert.equal(aRanked.wins, 1);

  const bRanked = await ranked.getUserRanked(b.id);
  assert.equal(bRanked.rating, 984);
  assert.equal(bRanked.wins, 0);
});

test('deltas surface won + expectedWinRate (equal ratings ⇒ 0.5) for the match-end UI', async () => {
  const { ranked, a, b } = await setup();
  await ranked.createSeason('Sezoni 1');
  const deltas = await ranked.recordMatchResult([{ userId: a.id, won: true }, { userId: b.id, won: false }]);
  const aDelta = deltas.find((d) => d.userId === a.id)!;
  const bDelta = deltas.find((d) => d.userId === b.id)!;
  assert.equal(aDelta.won, true);
  assert.equal(bDelta.won, false);
  // Both start at 1000 ⇒ each expected to win 50% against the other.
  assert.equal(aDelta.expectedWinRate, 0.5);
  assert.equal(bDelta.expectedWinRate, 0.5);
});

test('peakRating is sticky: it survives a subsequent rating drop', async () => {
  const { ranked, a, b } = await setup();
  await ranked.createSeason('Sezoni 1');
  await ranked.recordMatchResult([{ userId: a.id, won: true }, { userId: b.id, won: false }]);  // a: 1016
  await ranked.recordMatchResult([{ userId: a.id, won: false }, { userId: b.id, won: true }]);  // a falls
  const aRanked = await ranked.getUserRanked(a.id);
  assert.ok(aRanked.rating < 1016);
  assert.equal(aRanked.peakRating, 1016); // peak held
  assert.equal(aRanked.games, 2);
});

test('a voided match (no winner) is not rated', async () => {
  const { ranked, a, b } = await setup();
  await ranked.createSeason('Sezoni 1');
  const deltas = await ranked.recordMatchResult([{ userId: a.id, won: false }, { userId: b.id, won: false }]);
  assert.deepEqual(deltas, []);
  assert.equal((await ranked.getUserRanked(a.id)).games, 0); // untouched
});

test('leaderboard ranks by rating DESC with usernames + tiers', async () => {
  const { ranked, a, b, c } = await setup();
  await ranked.createSeason('Sezoni 1');
  // a beats both b and c in a 3-player game ⇒ a highest, b/c equal-lower.
  await ranked.recordMatchResult([
    { userId: a.id, won: true }, { userId: b.id, won: false }, { userId: c.id, won: false },
  ]);
  const board = await ranked.leaderboard();
  assert.equal(board.length, 3);
  assert.equal(board[0]!.rank, 1);
  assert.equal(board[0]!.userId, a.id);
  assert.equal(board[0]!.username, 'Anila');
  // Every row's username resolves via the single batch fetch (no '—' placeholders).
  assert.ok(board.every((row) => row.username !== '—'), 'all usernames batch-resolved');
  assert.ok(board[0]!.rating > board[1]!.rating);
  assert.equal(board[0]!.tier.key, 'bronze');
  assert.equal(typeof board[0]!.tier.emoji, 'string');
});

test('opening a new season archives the old one and carries peak forward via soft reset', async () => {
  const { ranked, a, b } = await setup();
  await ranked.createSeason('Sezoni 1', 0.5);
  // Push a's rating up across several wins so peak is well above default.
  for (let i = 0; i < 5; i += 1) {
    await ranked.recordMatchResult([{ userId: a.id, won: true }, { userId: b.id, won: false }]);
  }
  const beforePeak = (await ranked.getUserRanked(a.id)).peakRating;
  assert.ok(beforePeak > 1000);

  const s2 = await ranked.createSeason('Sezoni 2');
  assert.equal(s2.number, 2);
  const seasons = await ranked.listSeasons();
  assert.equal(seasons.length, 2);
  assert.equal(seasons.find((s) => s.number === 1)!.status, 'archived');

  // New season seeded by soft reset: halfway between the old peak and 1000.
  const a2 = await ranked.getUserRanked(a.id);
  assert.equal(a2.season!.number, 2);
  assert.equal(a2.rating, Math.round(beforePeak * 0.5 + 1000 * 0.5));
  assert.equal(a2.games, 0); // fresh ladder
  assert.equal(a2.wins, 0);
});

test('tiers() exposes the full ladder with the next-tier link', async () => {
  const { ranked } = await setup();
  const tiers = ranked.tiers();
  assert.equal(tiers[0]!.key, 'bronze');
  assert.equal(tiers[0]!.next!.key, 'silver');
  assert.equal(tiers[tiers.length - 1]!.key, 'master');
  assert.equal(tiers[tiers.length - 1]!.next, null);
});
