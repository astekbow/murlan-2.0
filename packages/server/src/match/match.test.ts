import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '@murlan/engine';
import { cardId } from '@murlan/engine';
import { Match, type MatchEvent } from './match.ts';

const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });

/** A deterministic dealer that hands out scripted games in sequence. */
function dealer(scripts: Card[][][]): () => Card[][] {
  let i = 0;
  return () => {
    const idx = Math.min(i, scripts.length - 1);
    i += 1;
    return scripts[idx]!.map((hand) => hand.map((card) => ({ ...card })));
  };
}

function find(events: MatchEvent[], kind: MatchEvent['kind']): any {
  return events.find((e) => e.kind === kind);
}
function idset(cards: readonly Card[]): Set<string> {
  return new Set(cards.map(cardId));
}

// ============================================================================
test('construction: the 3♠ holder leads game 1 and must open with the 3♠', () => {
  const m = new Match({
    type: '1v1',
    startTarget: 100, // keep the match going
    deal: dealer([[[c('5', 'S')], [c('3', 'S'), c('9', 'S')]]]), // seat1 holds 3♠
  });
  const s = m.snapshot();
  assert.equal(s.state, 'playing');
  assert.equal(s.game?.turn, 1); // seat1 leads (holds 3♠)

  assert.equal(m.play(1, [c('9', 'S')]).ok, false); // opening must include 3♠
  assert.ok(m.play(1, [c('3', 'S')]).ok);            // valid opening
  assert.equal(m.snapshot().game?.turn, 0);          // advanced to opponent
});

test('game 1 opener may be ANY valid combo containing the 3♠ (pair of threes / kolor)', () => {
  // A PAIR of threes, one being the 3♠, opens.
  const mPair = new Match({
    type: '1v1',
    startTarget: 100,
    deal: dealer([[[c('3', 'S'), c('3', 'H'), c('9', 'D')], [c('4', 'S')]]]),
  });
  assert.equal(mPair.snapshot().game?.turn, 0);                 // seat0 holds the 3♠ → leads
  assert.equal(mPair.play(0, [c('9', 'D')]).ok, false);         // a combo WITHOUT the 3♠ is rejected
  assert.ok(mPair.play(0, [c('3', 'S'), c('3', 'H')]).ok);      // pair of threes incl. 3♠ opens

  // A KOLOR (run) that contains the 3♠ opens.
  const mKolor = new Match({
    type: '1v1',
    startTarget: 100,
    deal: dealer([[[c('3', 'S'), c('4', 'H'), c('5', 'D'), c('6', 'C'), c('7', 'S')], [c('8', 'S'), c('9', 'S')]]]),
  });
  assert.ok(mKolor.play(0, [c('3', 'S'), c('4', 'H'), c('5', 'D'), c('6', 'C'), c('7', 'S')]).ok); // kolor incl. 3♠ opens
});

test('game 1 with NO 3♠ dealt (1v1): the lowest start-suit card present opens', () => {
  const m = new Match({
    type: '1v1',
    startTarget: 100,
    deal: dealer([[[c('7', 'S'), c('9', 'H')], [c('4', 'S'), c('8', 'D')]]]), // no 3♠ anywhere; 4♠ is the lowest spade (seat1)
  });
  const s = m.snapshot();
  assert.equal(s.game?.turn, 1);                      // seat1 leads — holds the 4♠
  assert.equal(m.play(1, [c('8', 'D')]).ok, false);   // the opening must include the 4♠
  assert.ok(m.play(1, [c('4', 'S')]).ok);             // valid opening with the 4♠
});

test('no-swap: a previous loser dealt BOTH jokers keeps them; no switch, and the WINNER leads', () => {
  const BJ: Card = { kind: 'joker', color: 'black' };
  const RJ: Card = { kind: 'joker', color: 'red' };
  const m = new Match({
    type: '1v1',
    startTarget: 100,
    deal: dealer([
      [[c('3', 'S')], [c('4', 'S')]],            // game1: seat0 wins, seat1 loses
      [[c('5', 'S'), c('6', 'S')], [BJ, RJ]],    // game2: the loser (seat1) gets BOTH jokers
    ]),
  });
  const r1 = m.play(0, [c('3', 'S')]); // finish game1 → prepare game2
  const noSwap = find(r1.matchEvents, 'noSwap');
  assert.ok(noSwap, 'noSwap emitted');
  assert.equal(noSwap.winner, 0);
  assert.equal(noSwap.loser, 1);
  assert.equal(find(r1.matchEvents, 'cardSwitchAuto'), undefined); // no auto-give happened
  assert.equal(find(r1.matchEvents, 'gameStarted').leader, 0);     // the WINNER leads, not the loser

  const s = m.snapshot();
  assert.equal(s.state, 'playing');
  assert.equal(s.game?.turn, 0);
  assert.deepEqual(idset(m.handOf(1)), idset([BJ, RJ]));                 // loser KEEPS both jokers
  assert.deepEqual(idset(m.handOf(0)), idset([c('5', 'S'), c('6', 'S')])); // winner's hand unchanged
});

test('1v1: a finished game is scored and the match ends at target', () => {
  const m = new Match({
    type: '1v1',
    startTarget: 1, // one win is enough
    deal: dealer([[[c('3', 'S')], [c('4', 'S')]]]), // seat0 holds 3♠ and will win
  });
  const r = m.play(0, [c('3', 'S')]); // seat0 opens with 3♠, empties hand -> wins -> match over
  assert.ok(r.ok);

  const scored = find(r.matchEvents, 'gameScored');
  assert.deepEqual(scored.finishingOrder, [0, 1]);
  assert.deepEqual(scored.points, [1, 0]);

  const ended = find(r.matchEvents, 'matchEnded');
  assert.ok(ended, 'matchEnded emitted');
  assert.equal(ended.winnerSide, 0);
  assert.deepEqual(ended.winnerSeats, [0]);

  const s = m.snapshot();
  assert.equal(s.state, 'matchOver');
  assert.deepEqual(s.cumulative, [1, 0]);
  assert.deepEqual(s.matchWinner, { side: 0, seats: [0] });
});

test('card switch: loser auto-gives strongest, winner returns a 3–10, loser leads next', () => {
  const m = new Match({
    type: '1v1',
    startTarget: 100,
    deal: dealer([
      [[c('3', 'S')], [c('4', 'S')]],           // game 1: seat0 wins, seat1 loses
      [[c('5', 'S')], [c('6', 'S'), c('7', 'S')]], // game 2 deal
    ]),
  });
  const r1 = m.play(0, [c('3', 'S')]); // finish game 1
  // Between games: loser (seat1) strongest is 7♠ -> goes to winner (seat0).
  const auto = find(r1.matchEvents, 'cardSwitchAuto');
  assert.equal(auto.loser, 1);
  assert.equal(auto.winner, 0);
  assert.equal(cardId(auto.card), cardId(c('7', 'S')));

  const awaiting = find(r1.matchEvents, 'awaitingSwitch');
  assert.ok(awaiting);
  const s1 = m.snapshot();
  assert.equal(s1.state, 'awaitingSwitch');
  assert.deepEqual(s1.pendingSwitch, { winner: 0, loser: 1 });
  // Winner now holds 5♠ + the just-received 7♠. Only 5♠ is returnable — the
  // winner may NOT hand the received card straight back (that would nullify the
  // loser's penalty).
  assert.deepEqual(idset(m.eligibleReturnCardsForWinner()), idset([c('5', 'S')]));
  assert.match(m.switchGive(0, c('7', 'S')).reason!, /njëjt/); // returning the received card is rejected

  // Winner returns the 5♠ to the loser.
  const r2 = m.switchGive(0, c('5', 'S'));
  assert.ok(r2.ok);
  const ret = find(r2.matchEvents, 'cardSwitchReturn');
  assert.equal(cardId(ret.card), cardId(c('5', 'S')));
  const started = find(r2.matchEvents, 'gameStarted');
  assert.equal(started.leader, 1); // the previous loser leads the new game

  const s2 = m.snapshot();
  assert.equal(s2.state, 'playing');
  assert.equal(s2.game?.turn, 1);
  assert.deepEqual(idset(m.handOf(0)), idset([c('7', 'S')]));          // kept 7♠
  assert.deepEqual(idset(m.handOf(1)), idset([c('6', 'S'), c('5', 'S')])); // 6♠ + returned 5♠
});

test('switchGive validation: wrong player, non-3–10 card, unheld card, and not-awaiting', () => {
  const setup = () =>
    new Match({
      type: '1v1',
      startTarget: 100,
      deal: dealer([
        [[c('3', 'S')], [c('4', 'S')]],
        [[c('5', 'S')], [c('6', 'S'), c('J', 'S')]],
      ]),
    });

  const m = setup();
  m.play(0, [c('3', 'S')]); // -> awaitingSwitch (winner seat0 holds 5♠ + received J♠)

  assert.equal(m.switchGive(1, c('5', 'S')).ok, false);            // not the winner
  assert.match(m.switchGive(0, c('J', 'S')).reason!, /3–10/);       // J is not rank 3–10
  assert.match(m.switchGive(0, c('9', 'S')).reason!, /letër/);      // not in winner's hand
  assert.ok(m.switchGive(0, c('5', 'S')).ok);                       // valid
  assert.match(m.switchGive(0, c('5', 'S')).reason!, /pritje/);     // no longer awaiting
});

test('1v1 tie at target − 1 extends the target by 10', () => {
  const m = new Match({
    type: '1v1',
    startTarget: 2,
    deal: dealer([
      [[c('3', 'S')], [c('4', 'S')]], // game1: seat0 wins -> [1,0]
      [[c('6', 'S')], [c('5', 'S')]], // game2 deal
      [[c('3', 'S')], [c('4', 'S')]], // game3 deal (so prepareNextGame can run)
    ]),
  });
  m.play(0, [c('3', 'S')]); // game1 done, continue (1 < 2)
  // game2 switch: loser seat1 strongest 5♠ -> seat0; winner returns 6♠ -> seat1
  m.switchGive(0, c('6', 'S'));
  // game2: loser seat1 leads its single 6♠, empties, WINS -> cumulative [1,1]
  const r = m.play(1, [c('6', 'S')]);
  const scored = find(r.matchEvents, 'gameScored');
  assert.deepEqual(scored.cumulative, [1, 1]);
  const ext = find(r.matchEvents, 'targetExtended');
  assert.ok(ext, 'targetExtended emitted on a 1-1 tie at target 2');
  assert.equal(ext.newTarget, 12);
  assert.equal(m.currentTarget, 12);
  assert.notEqual(m.currentState, 'matchOver'); // match continues
});

test('2v2: team scoring decides the match (seats 0&2 vs 1&3)', () => {
  const m = new Match({
    type: '2v2',
    startTarget: 3,
    deal: dealer([[[c('3', 'S')], [c('4', 'S')], [c('5', 'S')], [c('6', 'S')]]]),
  });
  m.play(0, [c('3', 'S')]); // seat0 opens & finishes 1st
  m.play(1, [c('4', 'S')]); // seat1 finishes 2nd
  const r = m.play(2, [c('5', 'S')]); // seat2 finishes 3rd; seat3 left -> 4th, game & match end

  const scored = find(r.matchEvents, 'gameScored');
  assert.deepEqual(scored.finishingOrder, [0, 1, 2, 3]);
  assert.deepEqual(scored.points, [3, 2, 1, 0]);       // per-seat
  assert.deepEqual(scored.teamCumulative, [4, 2]);      // team0 = 3+1, team1 = 2+0

  const ended = find(r.matchEvents, 'matchEnded');
  assert.equal(ended.winnerSide, 0);
  assert.deepEqual(ended.winnerSeats, [0, 2]);
  assert.deepEqual(m.snapshot().teamCumulative, [4, 2]);
});

test('1v1 fallback: when NO start-suit card is dealt at all, seat 0 leads with a free opening', () => {
  const m = new Match({
    type: '1v1',
    startTarget: 100,
    deal: dealer([[[c('5', 'H'), c('9', 'D')], [c('4', 'C')]]]), // no ♠ anywhere → nothing to require
  });
  assert.equal(m.snapshot().game?.turn, 0);     // seat0 leads by fallback
  assert.ok(m.play(0, [c('5', 'H')]).ok);        // opening is free (no start-suit card exists)
});
