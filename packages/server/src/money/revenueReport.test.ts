import test from 'node:test';
import assert from 'node:assert/strict';
import { revenueBreakdown, type RakeRow } from './revenueReport.ts';

// 2026-06-10 and 2026-06-11 UTC, in epoch ms.
const D10 = Date.UTC(2026, 5, 10, 12, 0, 0);
const D11 = Date.UTC(2026, 5, 11, 3, 30, 0);

test('revenueBreakdown totals every rake row by magnitude', () => {
  const rows: RakeRow[] = [
    { amountCents: 100, matchId: 'm1', createdAt: D10 },
    { amountCents: 250, matchId: 'm2', createdAt: D10 },
    { amountCents: 50, matchId: 'm3', createdAt: D11 },
  ];
  const r = revenueBreakdown(rows, new Map([['m1', '1v1'], ['m2', '2v2'], ['m3', '1v1']]));
  assert.equal(r.totalRakeCents, 400);
  assert.equal(r.rakeCount, 3);
});

test('byDay buckets by UTC day, newest first', () => {
  const rows: RakeRow[] = [
    { amountCents: 100, matchId: 'm1', createdAt: D10 },
    { amountCents: 250, matchId: 'm2', createdAt: D10 },
    { amountCents: 50, matchId: 'm3', createdAt: D11 },
  ];
  const r = revenueBreakdown(rows, new Map());
  assert.equal(r.byDay.length, 2);
  assert.deepEqual(r.byDay[0], { date: '2026-06-11', rakeCents: 50, matchCount: 1 });
  assert.deepEqual(r.byDay[1], { date: '2026-06-10', rakeCents: 350, matchCount: 2 });
});

test('byType joins match type, largest first; unknown when unmapped', () => {
  const rows: RakeRow[] = [
    { amountCents: 100, matchId: 'm1', createdAt: D10 },
    { amountCents: 250, matchId: 'm2', createdAt: D10 },
    { amountCents: 70, matchId: null, createdAt: D11 },
  ];
  const r = revenueBreakdown(rows, new Map([['m1', '1v1'], ['m2', '1v1']]));
  assert.deepEqual(r.byType[0], { type: '1v1', rakeCents: 350, matchCount: 2 });
  assert.ok(r.byType.some((t) => t.type === 'unknown' && t.rakeCents === 70));
});

test('maxDays caps the byDay series but not the totals', () => {
  const rows: RakeRow[] = [
    { amountCents: 10, matchId: 'a', createdAt: Date.UTC(2026, 0, 1) },
    { amountCents: 20, matchId: 'b', createdAt: Date.UTC(2026, 0, 2) },
    { amountCents: 30, matchId: 'c', createdAt: Date.UTC(2026, 0, 3) },
  ];
  const r = revenueBreakdown(rows, new Map(), { maxDays: 2 });
  assert.equal(r.byDay.length, 2);
  assert.equal(r.byDay[0]!.date, '2026-01-03'); // newest kept
  assert.equal(r.totalRakeCents, 60);           // total still counts all
});

test('empty ledger yields zeroes', () => {
  const r = revenueBreakdown([], new Map());
  assert.deepEqual(r, { totalRakeCents: 0, rakeCount: 0, byDay: [], byType: [] });
});
