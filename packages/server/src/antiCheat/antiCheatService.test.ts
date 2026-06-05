import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { InMemoryMatchActions } from '../realtime/matchActions.ts';
import { InMemorySuspicion } from './suspicionRepository.ts';
import { AntiCheatService } from './antiCheatService.ts';

test('analyzeMatch flags a bot-timing seat + a high-win-rate player; persists for review', async () => {
  const users = new InMemoryUserRepository();
  const matchLog = new InMemoryMatchActions();
  const suspicion = new InMemorySuspicion();
  const svc = new AntiCheatService(matchLog, users, suspicion);

  const human = await users.create({ username: 'human', email: 'h@h.com', passwordHash: 'h' });
  const bot = await users.create({ username: 'bot', email: 'b@b.com', passwordHash: 'h' });
  // Give the "bot" an implausible win rate too (40/40).
  for (let i = 0; i < 40; i += 1) await users.applyMatchResult(bot.id, { won: true, potCents: 0, xpGain: 0 });

  // Move-log: seat 0 (human) responds in varied seconds; seat 1 (bot) ~80ms each.
  const humanGaps = [3000, 7000, 2000, 9000, 4500, 6000, 2500, 8000, 3500, 5500, 4000, 7500];
  let at = 1_000_000;
  let seq = 0;
  for (let i = 0; i < 12; i += 1) {
    at += humanGaps[i]!;
    await matchLog.append({ matchId: 'm1', seq: seq++, gameIndex: 0, seat: 0, type: 'play', cards: null, at });
    at += 80;
    await matchLog.append({ matchId: 'm1', seq: seq++, gameIndex: 0, seat: 1, type: 'play', cards: null, at });
  }

  await svc.analyzeMatch('m1', [{ seat: 0, userId: human.id }, { seat: 1, userId: bot.id }]);

  const flags = await svc.listFlags();
  const botFlags = flags.filter((f) => f.userId === bot.id);
  assert.ok(botFlags.some((f) => f.type === 'bot_timing'), 'bot timing flagged');
  assert.ok(botFlags.some((f) => f.type === 'win_rate'), 'win-rate flagged');
  assert.equal(flags.some((f) => f.userId === human.id), false); // human not flagged
  assert.equal(flags.every((f) => f.matchId === 'm1' || f.type === 'win_rate'), true);

  // Severity filter for the admin triage list.
  assert.ok((await svc.listFlags({ minSeverity: 3 })).length >= 1);
});

test('analyzeMatch records a collusion_pairing flag once a staked pair repeats, naming the partner', async () => {
  const users = new InMemoryUserRepository();
  const svc = new AntiCheatService(new InMemoryMatchActions(), users, new InMemorySuspicion());
  const a = await users.create({ username: 'alba', email: 'a@a.com', passwordHash: 'h' });
  const b = await users.create({ username: 'beni', email: 'b@b.com', passwordHash: 'h' });

  // Three staked 1v1 matches between the same pair (winners alternated → no chip-dump).
  const seats = (aWon: boolean) => [
    { seat: 0, userId: a.id, won: aWon, team: null },
    { seat: 1, userId: b.id, won: !aWon, team: null },
  ];
  await svc.analyzeMatch('m1', seats(true), { staked: true });
  await svc.analyzeMatch('m2', seats(false), { staked: true });
  let flags = await svc.listFlags();
  assert.equal(flags.length, 0, 'no flag before the threshold');
  await svc.analyzeMatch('m3', seats(true), { staked: true });

  flags = await svc.listFlags();
  const pairing = flags.filter((f) => f.type === 'collusion_pairing');
  assert.equal(pairing.length, 2);
  const aFlag = pairing.find((f) => f.userId === a.id)!;
  assert.match(aFlag.detail, /beni/); // partner resolved to a username, not a raw id
});

test('collusion analysis is skipped for FREE (non-staked) tables', async () => {
  const users = new InMemoryUserRepository();
  const svc = new AntiCheatService(new InMemoryMatchActions(), users, new InMemorySuspicion());
  const a = await users.create({ username: 'a2', email: 'a2@a.com', passwordHash: 'h' });
  const b = await users.create({ username: 'b2', email: 'b2@b.com', passwordHash: 'h' });
  const seats = [{ seat: 0, userId: a.id, won: true, team: null }, { seat: 1, userId: b.id, won: false, team: null }];
  for (const id of ['f1', 'f2', 'f3', 'f4']) await svc.analyzeMatch(id, seats, { staked: false });
  assert.equal((await svc.listFlags()).length, 0);
});
