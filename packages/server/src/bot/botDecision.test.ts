import test from 'node:test';
import assert from 'node:assert/strict';
import { type Card, type Rank, type Suit, identifyCombo, validatePlay } from '@murlan/engine';
import { decideBotMove, enumerateLegalPlays, type BotView, type BotTier } from './botDecision.ts';

const c = (rank: Rank, suit: Suit): Card => ({ kind: 'standard', rank, suit });
const combo = (cards: Card[]) => identifyCombo(cards)!;
/** Deterministic rng cycling through the given values (for the Easy tier). */
const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]!; };
const TIERS: BotTier[] = ['easy', 'medium', 'hard'];

test('every returned play is LEGAL against the pile (all tiers)', () => {
  const hands: Card[][] = [
    [c('3', 'S'), c('9', 'S'), c('9', 'H'), c('K', 'C')],
    [c('4', 'S'), c('4', 'H'), c('4', 'D'), c('4', 'C'), c('9', 'S')],
    [c('5', 'S'), c('6', 'S'), c('7', 'S'), c('8', 'S'), c('9', 'S'), c('2', 'H')],
  ];
  const piles = [null, combo([c('5', 'S')]), combo([c('7', 'H'), c('7', 'D')])];
  for (const hand of hands) {
    for (const pile of piles) {
      for (const tier of TIERS) {
        const view: BotView = { hand, pile, canPass: pile !== null, opponentCounts: [5, 5] };
        const move = decideBotMove(view, tier, seq([0.1, 0.5, 0.9, 0.3]));
        if (move.action === 'play') {
          assert.ok(validatePlay(move.cards, pile).ok, `illegal ${tier} play`);
          assert.ok(move.cards.every((card) => hand.includes(card)), 'played a card not in hand');
        }
      }
    }
  }
});

test('a leader (canPass=false) NEVER passes — always finds a legal lead', () => {
  const view: BotView = { hand: [c('3', 'S')], pile: null, canPass: false, opponentCounts: [3] };
  for (const tier of TIERS) {
    const move = decideBotMove(view, tier, seq([0.0])); // even rng=0 must not pass when leading
    assert.equal(move.action, 'play', `${tier} passed while leading`);
  }
});

test('responding with no beating play ⇒ pass', () => {
  const view: BotView = { hand: [c('3', 'S')], pile: combo([c('K', 'S')]), canPass: true, opponentCounts: [4] };
  for (const tier of TIERS) {
    assert.deepEqual(decideBotMove(view, tier, seq([0.9])), { action: 'pass' });
  }
});

test('medium hoards a bomb when a cheaper non-trump beats the pile', () => {
  const hand = [c('4', 'S'), c('4', 'H'), c('4', 'D'), c('4', 'C'), c('9', 'S')];
  const view: BotView = { hand, pile: combo([c('5', 'S')]), canPass: true, opponentCounts: [6] };
  const move = decideBotMove(view, 'medium');
  assert.equal(move.action, 'play');
  if (move.action === 'play') assert.equal(move.cards.length, 1); // the single 9, not the 4-card bomb
});

test('medium/hard go out when a play empties the hand', () => {
  const view: BotView = { hand: [c('9', 'S')], pile: combo([c('5', 'S')]), canPass: true, opponentCounts: [3] };
  for (const tier of ['medium', 'hard'] as const) {
    const move = decideBotMove(view, tier);
    assert.deepEqual(move, { action: 'play', cards: [c('9', 'S')] });
  }
});

test('mustInclude (game-1 opening 3♠) is always respected', () => {
  const hand = [c('3', 'S'), c('9', 'S'), c('9', 'H')];
  const view: BotView = { hand, pile: null, canPass: false, opponentCounts: [4], mustInclude: c('3', 'S') };
  for (const tier of TIERS) {
    const move = decideBotMove(view, tier, seq([0.5]));
    assert.equal(move.action, 'play');
    if (move.action === 'play') assert.ok(move.cards.some((card) => card.kind === 'standard' && card.rank === '3' && card.suit === 'S'));
  }
});

test('hard leads its strongest single against a nearly-finished opponent', () => {
  const hand = [c('3', 'S'), c('5', 'S'), c('9', 'S')];
  const lead: BotView = { hand, pile: null, canPass: false, opponentCounts: [2] };
  // Hard denies the easy take with its highest single; medium leads the cheapest.
  assert.deepEqual(decideBotMove(lead, 'hard').action === 'play' && (decideBotMove(lead, 'hard') as { cards: Card[] }).cards, [c('9', 'S')]);
  assert.deepEqual(decideBotMove(lead, 'medium').action === 'play' && (decideBotMove(lead, 'medium') as { cards: Card[] }).cards, [c('3', 'S')]);
});

test('enumerateLegalPlays finds straights and trumps, and filters by the pile', () => {
  const hand = [c('5', 'S'), c('6', 'S'), c('7', 'S'), c('8', 'S'), c('9', 'S')]; // a flush
  const leads = enumerateLegalPlays(hand, null);
  assert.ok(leads.some((p) => p.type === 'flush' && p.size === 5), 'should propose the 5-card flush');
  assert.ok(leads.some((p) => p.type === 'single'), 'should propose singles');
  // Against a single, the flush (ultimate trump) is a legal response; so are higher singles.
  const responses = enumerateLegalPlays(hand, combo([c('5', 'H')]));
  assert.ok(responses.every((p) => validatePlay(p.cards, combo([c('5', 'H')])).ok));
  assert.ok(responses.some((p) => p.type === 'flush'));
});
