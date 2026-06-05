import test from 'node:test';
import assert from 'node:assert/strict';
import type { MatchActionRecord } from '../realtime/matchActions.ts';
import { moveTimingFlags, winRateFlag, collusionFlags, type PastMatch, type CollusionSeat } from './heuristics.ts';

// Build a move-log that alternates seats 0 and 1, with a given per-step gap (ms).
function log(seatGaps: Array<{ seat: number; gap: number }>): MatchActionRecord[] {
  let at = 1_000_000;
  return seatGaps.map((s, i) => {
    at += s.gap;
    return { matchId: 'm', seq: i, gameIndex: 0, seat: s.seat, type: 'play' as const, cards: null, at };
  });
}

test('moveTimingFlags: flags a seat that responds inhumanly fast', () => {
  // seat 1 always responds ~80ms; seat 0 takes a VARIED human amount of time.
  const human = [3000, 7000, 2000, 9000, 4500, 6000, 2500, 8000, 3500, 5500, 4000, 7500];
  const seq: Array<{ seat: number; gap: number }> = [];
  for (let i = 0; i < 12; i += 1) { seq.push({ seat: 0, gap: human[i]! }); seq.push({ seat: 1, gap: 80 }); }
  const flags = moveTimingFlags(log(seq));
  const f1 = flags.find((f) => f.seat === 1);
  assert.ok(f1, 'seat 1 flagged');
  assert.equal(f1!.type, 'bot_timing');
  assert.equal(f1!.severity, 3); // 80ms ≤ fastMs/2
  assert.equal(flags.find((f) => f.seat === 0), undefined); // varied human seat not flagged
});

test('moveTimingFlags: flags robotically-consistent timing even if not super fast', () => {
  // seat 1 responds at a steady 1200ms every time (very low variance); seat 0 varies.
  const gaps0 = [3000, 8000, 1500, 6000, 2200, 9000, 1200, 7000, 4000, 5000, 3300, 8800];
  const seq: Array<{ seat: number; gap: number }> = [];
  for (let i = 0; i < 12; i += 1) { seq.push({ seat: 0, gap: gaps0[i]! }); seq.push({ seat: 1, gap: 1200 }); }
  const flags = moveTimingFlags(seq.length ? log(seq) : []);
  const f1 = flags.find((f) => f.seat === 1);
  assert.ok(f1, 'steady seat 1 flagged');
  assert.match(f1!.detail, /konstante/);
});

test('moveTimingFlags: too few moves ⇒ no flag', () => {
  const actions = log([{ seat: 0, gap: 50 }, { seat: 1, gap: 50 }, { seat: 0, gap: 50 }]);
  assert.deepEqual(moveTimingFlags(actions), []);
});

test('winRateFlag: flags an implausible win rate over a large sample', () => {
  assert.equal(winRateFlag(10, 10), null);          // too few games
  assert.equal(winRateFlag(40, 20), null);          // 50% — normal
  const f = winRateFlag(40, 39);                    // 97.5% over 40
  assert.ok(f);
  assert.equal(f!.type, 'win_rate');
  assert.equal(f!.severity, 3);
  assert.equal(winRateFlag(40, 35)!.severity, 2);   // 87.5% — medium
});

// ---- Collusion -------------------------------------------------------------
const s = (userId: string, won: boolean, team: number | null = null): CollusionSeat => ({ userId, won, team });
const m = (...seats: CollusionSeat[]): PastMatch => ({ seats });

test('collusionFlags: repeat co-seating trips a pairing flag at the threshold (both players)', () => {
  // A and B meet 3 times (1v1), winners alternated so no chip-dump fires.
  const window = [m(s('A', true), s('B', false)), m(s('A', false), s('B', true)), m(s('A', true), s('B', false))];
  const flags = collusionFlags(window);
  const pairing = flags.filter((f) => f.type === 'collusion_pairing');
  assert.equal(pairing.length, 2); // one filed against each of A and B
  assert.ok(pairing.some((f) => f.userId === 'A' && f.partnerId === 'B'));
  assert.ok(pairing.some((f) => f.userId === 'B' && f.partnerId === 'A'));
  assert.equal(flags.some((f) => f.type === 'chip_dump'), false); // 2–1 split, not directional
});

test('collusionFlags: 2v2 TEAMMATES are never flagged as colluding with each other', () => {
  // Same 4 players, A+B always teammates (team 0), C+D team 1, three matches.
  const match = () => m(s('A', true, 0), s('B', true, 0), s('C', false, 1), s('D', false, 1));
  const flags = collusionFlags([match(), match(), match()]);
  assert.equal(flags.some((f) => (f.userId === 'A' && f.partnerId === 'B') || (f.userId === 'B' && f.partnerId === 'A')), false);
});

test('collusionFlags: a one-directional chip-dump trips a chip_dump flag (dumper high severity)', () => {
  // B beats A three times running, A never beats B ⇒ directional.
  const window = [m(s('A', false), s('B', true)), m(s('A', false), s('B', true)), m(s('A', false), s('B', true))];
  const flags = collusionFlags(window);
  const dump = flags.filter((f) => f.type === 'chip_dump');
  const dumper = dump.find((f) => f.userId === 'A');
  assert.ok(dumper, 'A flagged as the dumper');
  assert.equal(dumper!.partnerId, 'B');
  assert.equal(dumper!.severity, 3);
  assert.ok(dump.some((f) => f.userId === 'B' && f.severity === 2)); // beneficiary flagged medium
});
