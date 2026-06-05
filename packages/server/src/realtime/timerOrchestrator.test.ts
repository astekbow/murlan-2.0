import test from 'node:test';
import assert from 'node:assert/strict';
import { TimerOrchestrator } from './timerOrchestrator.ts';

test('turn timer: deadline is set on arm, cleared on clear, replaced on re-arm', () => {
  const t = new TimerOrchestrator();
  assert.equal(t.turnDeadline('r'), null);

  t.armTurn('r', 30_000, () => {});
  const d1 = t.turnDeadline('r');
  assert.ok(d1 !== null && d1 > Date.now() && d1 <= Date.now() + 30_050);

  t.armTurn('r', 1_000, () => {}); // re-arm replaces (idempotent)
  const d2 = t.turnDeadline('r')!;
  assert.ok(d2 < d1!); // shorter window now

  t.clearTurn('r');
  assert.equal(t.turnDeadline('r'), null);
  t.clearAll();
});

test('countdown: hasCountdown + deadline track arm/clear; fired timer self-cleans then fires', async () => {
  const t = new TimerOrchestrator();
  assert.equal(t.hasCountdown('r'), false);

  await new Promise<void>((resolve) => {
    t.armCountdown('r', 5, () => {
      // On expiry the entry is already gone (self-clean BEFORE the callback).
      assert.equal(t.hasCountdown('r'), false);
      assert.equal(t.countdownDeadline('r'), null);
      resolve();
    });
    assert.equal(t.hasCountdown('r'), true); // armed and pending
    assert.ok((t.countdownDeadline('r') ?? 0) > Date.now());
  });
});

test('turn timer does NOT self-clean on fire (deadline lingers until re-arm/clear)', async () => {
  const t = new TimerOrchestrator();
  await new Promise<void>((resolve) => {
    t.armTurn('r', 5, () => {
      // The deadline is still present during the expiry handler (matches the
      // gateway broadcasting the passed deadline before re-arming).
      assert.notEqual(t.turnDeadline('r'), null);
      resolve();
    });
  });
  t.clearAll();
});

test('clearAll cancels pending timers (no callback fires afterward)', async () => {
  const t = new TimerOrchestrator();
  let fired = false;
  t.armCountdown('r', 5, () => { fired = true; });
  t.armTurn('r', 5, () => { fired = true; });
  t.armAbandon('u', 5, () => { fired = true; });
  t.clearAll();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(fired, false);
});
