import test from 'node:test';
import assert from 'node:assert/strict';
import { type Card, type Rank, type Suit, identifyCombo, validatePlay, cardId } from '@murlan/engine';
import { chooseBestMove, _searchInternals } from './botSearch.ts';
import type { BotView } from './botDecision.ts';

const c = (rank: Rank, suit: Suit): Card => ({ kind: 'standard', rank, suit });
const combo = (cards: Card[]) => identifyCombo(cards)!;
const rng = () => 0.42; // fixed → deterministic determinizations

/** A 1v1 view with full public state so the search engages. */
function view(hand: Card[], extra: Partial<BotView> = {}): BotView {
  return {
    hand,
    pile: null,
    canPass: false,
    opponentCounts: [hand.length],
    mySeat: 0,
    numPlayers: 2,
    pileOwner: null,
    passed: [],
    active: [true, true],
    handCounts: [hand.length, hand.length],
    finishingOrder: [],
    seen: [],
    ...extra,
  };
}
const inHand = (cards: Card[], hand: Card[]) => {
  const ids = new Set(hand.map(cardId));
  return cards.every((x) => ids.has(cardId(x)));
};

test('search leads a LEGAL move and never passes', () => {
  const hand = [c('3', 'S'), c('7', 'H'), c('9', 'D'), c('9', 'C'), c('K', 'S')];
  const move = chooseBestMove(view(hand), rng);
  assert.ok(move && move.action === 'play', 'should play when leading');
  if (move.action === 'play') {
    assert.ok(validatePlay(move.cards, null).ok, 'lead must be legal');
    assert.ok(inHand(move.cards, hand), 'must play own cards');
  }
});

test('search takes a guaranteed go-out', () => {
  const move = chooseBestMove(view([c('9', 'S')], { pile: combo([c('5', 'S')]), canPass: true, handCounts: [1, 3] }), rng);
  assert.deepEqual(move, { action: 'play', cards: [c('9', 'S')] });
});

test('search respects mustInclude (opening 3♠)', () => {
  const hand = [c('3', 'S'), c('9', 'S'), c('9', 'H')];
  const move = chooseBestMove(view(hand, { mustInclude: c('3', 'S'), handCounts: [3, 3] }), rng);
  assert.ok(move && move.action === 'play');
  if (move.action === 'play') assert.ok(move.cards.some((x) => x.kind === 'standard' && x.rank === '3' && x.suit === 'S'));
});

test('search responds with a legal beating play (or a pass)', () => {
  const hand = [c('4', 'S'), c('K', 'H'), c('2', 'D')];
  const pile = combo([c('7', 'S')]);
  const move = chooseBestMove(view(hand, { pile, canPass: true, handCounts: [3, 4] }), rng);
  assert.ok(move);
  if (move.action === 'play') {
    assert.ok(validatePlay(move.cards, pile).ok, 'response must beat the pile');
    assert.ok(inHand(move.cards, hand));
  }
});

test('search returns null without rich context so the caller can fall back', () => {
  const move = chooseBestMove({ hand: [c('3', 'S')], pile: null, canPass: false, opponentCounts: [3] }, rng);
  assert.equal(move, null);
});

test('a 3-player lead is legal and from the hand', () => {
  const hand = [c('3', 'S'), c('4', 'S'), c('5', 'S'), c('6', 'S'), c('7', 'S'), c('K', 'H')];
  const move = chooseBestMove(view(hand, { numPlayers: 3, active: [true, true, true], handCounts: [6, 6, 6], opponentCounts: [6, 6] }), rng);
  assert.ok(move && move.action === 'play');
  if (move.action === 'play') {
    assert.ok(validatePlay(move.cards, null).ok);
    assert.ok(inHand(move.cards, hand));
  }
});

/** A 4-player 2v2 team view (seats 0&2 vs 1&3; this bot = seat 0, partner = seat 2). */
function teamView(hand: Card[], extra: Partial<BotView> = {}): BotView {
  return {
    hand, pile: null, canPass: false, opponentCounts: [4, 4, 4],
    mySeat: 0, numPlayers: 4, pileOwner: null, passed: [], active: [true, true, true, true],
    handCounts: [hand.length, 4, 4, 4], finishingOrder: [], seen: [], partnerSeat: 2, ...extra,
  };
}

test('search runs in a 2v2 team context and returns a legal move', () => {
  const hand = [c('3', 'S'), c('7', 'H'), c('9', 'D'), c('K', 'S')];
  const move = chooseBestMove(teamView(hand), rng);
  assert.ok(move && move.action === 'play');
  if (move && move.action === 'play') {
    assert.ok(validatePlay(move.cards, null).ok);
    assert.ok(inHand(move.cards, hand));
  }
});

test('playoutScore sums the whole TEAM in 2v2 but scores a single place solo', () => {
  const { determinize, playoutScore, unseen } = _searchInternals;
  const tv = teamView([c('3', 'S'), c('9', 'H')], { handCounts: [2, 2, 2, 2] });
  const teamScore = playoutScore(determinize(tv, unseen(tv), rng), 0, 2);
  assert.ok(teamScore >= 3 && teamScore <= 8, `team score is a sum of two places (3..8), got ${teamScore}`);

  const sv = view([c('3', 'S'), c('9', 'H')], { handCounts: [2, 2] });
  const soloScore = playoutScore(determinize(sv, unseen(sv), rng), 0, null);
  assert.ok(soloScore >= 1 && soloScore <= 2, `solo score is one place (1..2), got ${soloScore}`);
});
