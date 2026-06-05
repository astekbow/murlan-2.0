import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSettlement, potCents } from './settlement.ts';

test('pot = stake × players', () => {
  assert.equal(potCents(1000, 2), 2000);
  assert.equal(potCents(1000, 4), 4000);
});

test('1v1: $10 stake, 10% rake -> winner $18, house $2', () => {
  const s = computeSettlement({ potCents: 2000, rakeBps: 1000, winnerSeats: [0] });
  assert.equal(s.rakeCents, 200);
  assert.deepEqual(s.payouts, [{ seat: 0, amountCents: 1800 }]);
  assert.equal(s.payouts[0]!.amountCents + s.rakeCents, s.potCents); // conservation
});

test('2v2: pot split equally between the two winning teammates after rake', () => {
  // 4 × $5 = $20 pot, 10% rake = $2, take $18 -> $9 each
  const s = computeSettlement({ potCents: 2000, rakeBps: 1000, winnerSeats: [0, 2] });
  assert.equal(s.rakeCents, 200);
  assert.deepEqual(s.payouts, [
    { seat: 0, amountCents: 900 },
    { seat: 2, amountCents: 900 },
  ]);
});

test('odd remainder cent in a 2v2 split goes to the first winner (no cent lost)', () => {
  // pot 2001, rake floor(2001*0.10)=200, take 1801 -> 901 / 900
  const s = computeSettlement({ potCents: 2001, rakeBps: 1000, winnerSeats: [1, 3] });
  assert.equal(s.rakeCents, 200);
  assert.deepEqual(s.payouts, [
    { seat: 1, amountCents: 901 },
    { seat: 3, amountCents: 900 },
  ]);
  assert.equal(s.payouts[0]!.amountCents + s.payouts[1]!.amountCents + s.rakeCents, s.potCents);
});

test('rake uses floor so the winner is never short-changed a cent', () => {
  // pot 999, 10% -> floor(99.9)=99 rake, winner 900
  const s = computeSettlement({ potCents: 999, rakeBps: 1000, winnerSeats: [0] });
  assert.equal(s.rakeCents, 99);
  assert.equal(s.payouts[0]!.amountCents, 900);
  assert.equal(s.payouts[0]!.amountCents + s.rakeCents, 999);
});

test('0% rake gives the entire pot to the winner', () => {
  const s = computeSettlement({ potCents: 3000, rakeBps: 0, winnerSeats: [2] });
  assert.equal(s.rakeCents, 0);
  assert.equal(s.payouts[0]!.amountCents, 3000);
});

test('conservation holds across a sweep of pots and rakes', () => {
  for (const pot of [0, 1, 2, 99, 100, 2000, 2001, 4000, 12345]) {
    for (const rakeBps of [0, 250, 1000, 1500, 10000]) {
      for (const winners of [[0], [1, 3]]) {
        const s = computeSettlement({ potCents: pot, rakeBps, winnerSeats: winners });
        const paid = s.payouts.reduce((a, p) => a + p.amountCents, 0);
        assert.equal(paid + s.rakeCents, pot, `pot=${pot} rake=${rakeBps} winners=${winners}`);
        assert.ok(s.payouts.every((p) => p.amountCents >= 0));
        assert.ok(s.rakeCents >= 0);
      }
    }
  }
});
