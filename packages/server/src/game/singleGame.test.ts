import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import { SingleGame, type GameEvent } from './singleGame.ts';

// ---- card helpers -----------------------------------------------------------
const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });
const BJ: Card = { kind: 'joker', color: 'black' };
const RJ: Card = { kind: 'joker', color: 'red' };

function evkinds(events: GameEvent[]): string[] {
  return events.map((e) => e.kind);
}
function lastEvent(events: GameEvent[], kind: GameEvent['kind']): any {
  return [...events].reverse().find((e) => e.kind === kind);
}

// ============================================================================
test('construction: turn starts on the leader, all dealt seats active', () => {
  const g = new SingleGame({
    numPlayers: 3,
    hands: [[c('3', 'S')], [c('4', 'S')], [c('5', 'S')]],
    leader: 1,
  });
  const s = g.snapshot();
  assert.equal(s.turn, 1);
  assert.equal(s.status, 'playing');
  assert.deepEqual(s.handCounts, [1, 1, 1]);
  assert.deepEqual(s.active, [true, true, true]);
  assert.equal(s.pile, null);
});

test('leading: any valid combo is accepted and becomes the pile', () => {
  const g = new SingleGame({
    numPlayers: 2,
    hands: [[c('7', 'S'), c('9', 'S')], [c('8', 'S')]],
    leader: 0,
  });
  const r = g.play(0, [c('7', 'S')]);
  assert.ok(r.ok);
  assert.equal(g.snapshot().pileOwner, 0);
  assert.equal(g.currentPile()?.type, 'single');
  assert.equal(g.currentTurn, 1); // advanced to opponent
});

// ---- rejections -------------------------------------------------------------
test('rejects playing out of turn', () => {
  const g = new SingleGame({ numPlayers: 2, hands: [[c('7', 'S')], [c('8', 'S')]], leader: 0 });
  const r = g.play(1, [c('8', 'S')]);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /radha/i);
});

test('rejects an invalid combo when leading', () => {
  const g = new SingleGame({ numPlayers: 2, hands: [[c('3', 'S'), c('5', 'H')], [c('8', 'S')]], leader: 0 });
  const r = g.play(0, [c('3', 'S'), c('5', 'H')]); // not a real combo
  assert.equal(r.ok, false);
});

test('rejects passing while leading (leader must play)', () => {
  const g = new SingleGame({ numPlayers: 2, hands: [[c('7', 'S')], [c('8', 'S')]], leader: 0 });
  const r = g.pass(0);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /pasosh/i);
});

test('rejects playing cards you do not hold', () => {
  const g = new SingleGame({ numPlayers: 2, hands: [[c('7', 'S')], [c('8', 'S')]], leader: 0 });
  const r = g.play(0, [c('2', 'S')]);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /letra/i);
});

test('rejects a weaker response and accepts a stronger one (delegates to engine)', () => {
  const g = new SingleGame({ numPlayers: 2, hands: [[c('5', 'S'), c('Q', 'S')], [c('3', 'S'), c('9', 'S')]], leader: 0 });
  g.play(0, [c('5', 'S')]);            // pile = 5 (A keeps Q, stays active)
  assert.equal(g.play(1, [c('3', 'S')]).ok, false); // 3 cannot beat 5
  assert.equal(g.play(1, [c('9', 'S')]).ok, true);  // 9 beats 5
  assert.equal(g.snapshot().pileOwner, 1);
});

// ---- trick flow -------------------------------------------------------------
test('all opponents pass: last player wins the trick, pile clears, they lead', () => {
  const g = new SingleGame({
    numPlayers: 3,
    hands: [
      [c('5', 'S'), c('J', 'S'), c('3', 'H')], // A (keeps 3H so it stays active)
      [c('6', 'S'), c('K', 'S')],              // B
      [c('7', 'S'), c('Q', 'S')],              // C
    ],
    leader: 0,
  });
  g.play(0, [c('5', 'S')]); // A leads
  g.play(1, [c('6', 'S')]); // B beats
  g.play(2, [c('7', 'S')]); // C beats
  g.play(0, [c('J', 'S')]); // A beats (owner = A)
  assert.equal(g.currentTurn, 1);
  const r1 = g.pass(1); // B passes
  assert.deepEqual(evkinds(r1.events), ['passed']);
  assert.equal(g.currentTurn, 2);
  const r2 = g.pass(2); // C passes -> A wins the trick
  const won = lastEvent(r2.events, 'trickWon');
  assert.ok(won, 'trickWon emitted');
  assert.equal(won.winner, 0);
  assert.equal(won.leadsNext, 0);
  assert.equal(g.currentPile(), null);             // pile cleared
  assert.deepEqual(g.snapshot().passed, []);       // passes cleared
  assert.equal(g.currentTurn, 0);                  // A leads again
});

test('a player who passed is skipped for the rest of the trick', () => {
  const g = new SingleGame({
    numPlayers: 3,
    hands: [
      [c('5', 'S'), c('9', 'S')], // A
      [c('6', 'S')],              // B
      [c('7', 'S'), c('8', 'S')], // C
    ],
    leader: 0,
  });
  g.play(0, [c('5', 'S')]); // A leads, turn -> B
  g.pass(1);                // B passes, turn -> C
  assert.equal(g.currentTurn, 2);
  g.play(2, [c('7', 'S')]); // C beats; B already passed -> turn skips B back to A
  assert.equal(g.currentTurn, 0);
});

test('4-player turn order is respected end-to-end (no non-passed player is skipped)', () => {
  // Reproduces the owner-reported scenario: plays + passes around a full table, a player
  // WINS the trick, and we assert the EXACT turn after every action. A real skip bug
  // would show as a wrong currentTurn here.
  const g = new SingleGame({
    numPlayers: 4,
    hands: [
      [c('5', 'S'), c('9', 'S'), c('K', 'D')], // A(0)
      [c('6', 'S'), c('4', 'D'), c('4', 'C')], // B(1)
      [c('7', 'S'), c('J', 'S'), c('3', 'C')], // C(2)
      [c('8', 'S'), c('4', 'H'), c('2', 'C')], // D(3)
    ],
    leader: 0,
  });
  const turn = () => g.currentTurn;
  assert.equal(turn(), 0);
  g.play(0, [c('5', 'S')]); assert.equal(turn(), 1); // A→B
  g.play(1, [c('6', 'S')]); assert.equal(turn(), 2); // B→C
  g.play(2, [c('7', 'S')]); assert.equal(turn(), 3); // C→D
  g.play(3, [c('8', 'S')]); assert.equal(turn(), 0); // D→A (full loop, no skip)
  g.play(0, [c('9', 'S')]); assert.equal(turn(), 1); // A beats → B
  g.pass(1);                assert.equal(turn(), 2); // B passes → C (B now out for the trick)
  g.play(2, [c('J', 'S')]); assert.equal(turn(), 3); // C beats → D (correctly SKIPS passed B)
  g.pass(3);                assert.equal(turn(), 0); // D passes → A
  g.pass(0);                                          // A passes → all contenders passed → C wins
  assert.equal(turn(), 2);                            // trick won by C(owner) → C leads next
  assert.deepEqual(g.snapshot().passed, []);          // new trick: passes cleared, everyone back in
});

// ---- finishing & game end ---------------------------------------------------
test('emptying your hand records a finishing place and removes you from rotation', () => {
  const g = new SingleGame({
    numPlayers: 3,
    hands: [
      [c('5', 'S')],              // A — will finish first
      [c('6', 'S'), c('K', 'S')], // B
      [c('7', 'S'), c('Q', 'S')], // C
    ],
    leader: 0,
  });
  const r = g.play(0, [c('5', 'S')]); // A plays last card
  const fin = lastEvent(r.events, 'playerFinished');
  assert.equal(fin.seat, 0);
  assert.equal(fin.place, 1);
  assert.equal(g.snapshot().active[0], false);
  assert.equal(g.isOver, false); // two players remain
});

test('1v1: game ends when one player empties their hand, full order recorded', () => {
  const g = new SingleGame({
    numPlayers: 2,
    hands: [[c('3', 'S'), c('5', 'S')], [c('4', 'S'), c('6', 'S')]],
    leader: 0,
  });
  g.play(0, [c('3', 'S')]); // A
  g.play(1, [c('4', 'S')]); // B beats
  const r = g.play(0, [c('5', 'S')]); // A beats and empties hand -> finishes 1st, game ends
  assert.ok(g.isOver);
  const ended = lastEvent(r.events, 'gameEnded');
  assert.deepEqual(ended.finishingOrder, [0, 1]); // A first, B last
  assert.equal(g.currentTurn, null);
});

test('1v1v1: produces a complete 1st/2nd/3rd finishing order', () => {
  const g = new SingleGame({
    numPlayers: 3,
    hands: [
      [c('5', 'S'), c('9', 'S')], // A
      [c('6', 'S')],              // B (one card)
      [c('7', 'S'), c('8', 'S')], // C
    ],
    leader: 0,
  });
  // A:5 -> B passes -> C:7 (skip B) -> A:9 (A empties, finishes 1st)
  g.play(0, [c('5', 'S')]);
  g.pass(1);
  g.play(2, [c('7', 'S')]);
  const rA = g.play(0, [c('9', 'S')]);
  assert.equal(lastEvent(rA.events, 'playerFinished').place, 1);
  assert.equal(g.isOver, false);
  // Pile owner A is finished; only C can act on the 9 -> C passes -> A wins trick,
  // lead passes to next active after A = B.
  const rC = g.pass(2);
  const won = lastEvent(rC.events, 'trickWon');
  assert.equal(won.winner, 0);
  assert.equal(won.leadsNext, 1); // lead passed to B since A is finished
  assert.equal(g.currentTurn, 1);
  // B leads its last card, empties hand (2nd), only C remains -> game ends, C last.
  const rB = g.play(1, [c('6', 'S')]);
  assert.ok(g.isOver);
  assert.deepEqual(lastEvent(rB.events, 'gameEnded').finishingOrder, [0, 1, 2]);
});

// ---- trump categories still apply through the machine -----------------------
test('engine trump rules apply: a bomb beats a single inside the machine', () => {
  const g = new SingleGame({
    numPlayers: 2,
    hands: [
      [c('A', 'S'), c('3', 'H')],                                 // A leads a single Ace (keeps 3H)
      [c('5', 'S'), c('5', 'H'), c('5', 'D'), c('5', 'C'), c('4', 'H')], // B: bomb + spare (stays active)
    ],
    leader: 0,
  });
  g.play(0, [c('A', 'S')]);
  const r = g.play(1, [c('5', 'S'), c('5', 'H'), c('5', 'D'), c('5', 'C')]);
  assert.ok(r.ok, 'bomb accepted over a single');
  assert.equal(g.currentPile()?.type, 'bomb');
});

test('engine trump rules apply: a flush beats a bomb inside the machine', () => {
  const g = new SingleGame({
    numPlayers: 2,
    hands: [
      [c('5', 'S'), c('5', 'H'), c('5', 'D'), c('5', 'C'), c('3', 'H')],            // A bomb (keeps 3H)
      [c('3', 'S'), c('4', 'S'), c('5', 'S'), c('6', 'S'), c('7', 'S'), c('9', 'H')], // B: flush + spare
    ],
    leader: 0,
  });
  g.play(0, [c('5', 'S'), c('5', 'H'), c('5', 'D'), c('5', 'C')]); // bomb leads
  const r = g.play(1, [c('3', 'S'), c('4', 'S'), c('5', 'S'), c('6', 'S'), c('7', 'S')]);
  assert.ok(r.ok, 'flush trumps a bomb');
  assert.equal(g.currentPile()?.type, 'flush');
});

// ---- jokers as singles ------------------------------------------------------
test('red joker can be played as a single and tops the power order', () => {
  const g = new SingleGame({ numPlayers: 2, hands: [[c('2', 'S'), c('3', 'H')], [BJ, RJ]], leader: 0 });
  g.play(0, [c('2', 'S')]);          // 2 is strong but below jokers (A keeps 3H)
  assert.equal(g.play(1, [BJ]).ok, true);  // black joker beats 2
});

// ---- opening-card rule (first game must open with 3♠) -----------------------
test('opening rule: the first play must include the configured opening card (3♠)', () => {
  const g = new SingleGame({
    numPlayers: 2,
    hands: [[c('3', 'S'), c('7', 'S')], [c('8', 'S')]],
    leader: 0,
    openingCard: c('3', 'S'),
  });
  // Opening with a combo that omits 3♠ is rejected...
  const bad = g.play(0, [c('7', 'S')]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason!, /3♠/);
  // ...opening with the 3♠ is accepted.
  const good = g.play(0, [c('3', 'S')]);
  assert.ok(good.ok);
});

test('opening rule: only the opening play is constrained, later leads are free', () => {
  const g = new SingleGame({
    numPlayers: 2,
    hands: [[c('3', 'S'), c('9', 'S')], [c('4', 'S')]],
    leader: 0,
    openingCard: c('3', 'S'),
  });
  g.play(0, [c('3', 'S')]); // valid opening (includes 3♠)
  g.pass(1);                // B passes -> A wins trick, leads again
  assert.equal(g.currentTurn, 0);
  assert.ok(g.play(0, [c('9', 'S')]).ok); // later lead need not include 3♠
});

test('opening rule does not apply when no opening card is configured', () => {
  const g = new SingleGame({
    numPlayers: 2,
    hands: [[c('3', 'S'), c('7', 'S')], [c('8', 'S')]],
    leader: 0,
  });
  assert.ok(g.play(0, [c('7', 'S')]).ok); // free opening
});

// ---- actions after game over are rejected -----------------------------------
test('no actions accepted once the game is finished', () => {
  const g = new SingleGame({ numPlayers: 2, hands: [[c('3', 'S')], [c('4', 'S')]], leader: 0 });
  g.play(0, [c('3', 'S')]); // A empties, game ends immediately
  assert.ok(g.isOver);
  const r = g.play(1, [c('4', 'S')]);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /mbaruar/i);
});
