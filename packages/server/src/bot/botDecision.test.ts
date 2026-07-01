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

test('medium/hard lead their strongest single against a nearly-finished opponent; easy leads cheapest', () => {
  const hand = [c('3', 'S'), c('5', 'S'), c('9', 'S')];
  const lead: BotView = { hand, pile: null, canPass: false, opponentCounts: [2] };
  for (const tier of ['medium', 'hard'] as const) {
    const m = decideBotMove(lead, tier);
    assert.deepEqual(m.action === 'play' && m.cards, [c('9', 'S')], `${tier} should deny with its strongest single`);
  }
  const easy = decideBotMove(lead, 'easy');
  assert.deepEqual(easy.action === 'play' && easy.cards, [c('3', 'S')]); // easy just leads the cheapest
});

test('easy leads its weakest isolated card and does NOT fracture a pair', () => {
  const hand = [c('3', 'S'), c('9', 'S'), c('9', 'H')]; // an isolated 3 + a pair of 9s
  const view: BotView = { hand, pile: null, canPass: false, opponentCounts: [6] };
  assert.deepEqual(decideBotMove(view, 'easy'), { action: 'play', cards: [c('3', 'S')] }); // throws the 3, keeps the pair
});

test('medium/hard spend a trump to stop an opponent about to win; easy hoards it', () => {
  const hand = [c('4', 'S'), c('4', 'H'), c('4', 'D'), c('4', 'C'), c('7', 'S')]; // bomb + a low 7
  const view: BotView = { hand, pile: combo([c('K', 'S')]), canPass: true, opponentCounts: [1] };
  // Only the bomb beats a King; an opponent is one card from winning.
  assert.deepEqual(decideBotMove(view, 'easy'), { action: 'pass' }); // beginner naively hoards the bomb
  for (const tier of ['medium', 'hard'] as const) {
    const m = decideBotMove(view, tier); // spends it to deny the win
    assert.equal(m.action, 'play');
    if (m.action === 'play') assert.equal(m.cards.length, 4); // the 4-card bomb
  }
});

test('medium/hard unload a whole run when leading; easy just dribbles its lowest single', () => {
  const hand = [c('4', 'S'), c('5', 'H'), c('6', 'D'), c('7', 'C'), c('8', 'S'), c('K', 'H')]; // a 4-8 kolor + a K
  const view: BotView = { hand, pile: null, canPass: false, opponentCounts: [9] };
  for (const tier of ['medium', 'hard'] as const) {
    const m = decideBotMove(view, tier);
    assert.equal(m.action === 'play' && m.cards.length, 5, `${tier} sheds the whole 5-card run`);
  }
  const easy = decideBotMove(view, 'easy');
  assert.equal(easy.action === 'play' && easy.cards.length, 1); // easy throws a single
});

// ---- TEAM PLAY (2v2): every tier cooperates with its partner ----------------

test('2v2 team: NEVER overtakes the partner — passes when the partner owns the pile (all tiers)', () => {
  const hand = [c('A', 'S'), c('K', 'H')]; // could easily beat the 5, but the partner is winning it
  const view: BotView = {
    hand, pile: combo([c('5', 'S')]), canPass: true, opponentCounts: [4, 4, 4],
    mySeat: 0, numPlayers: 4, pileOwner: 2, handCounts: [2, 5, 3, 5], partnerSeat: 2,
  };
  for (const tier of TIERS) {
    assert.deepEqual(decideBotMove(view, tier), { action: 'pass' }, `${tier} overtook its own partner`);
  }
});

test('2v2 team: sets a near-finished partner up — leads a LOW single when the partner has 1 card (all tiers)', () => {
  const hand = [c('3', 'S'), c('K', 'H'), c('A', 'D')];
  // Leading; partner (seat 2) is on their last card; the next opponent (seat 1) has plenty → safe to feed low.
  const view: BotView = {
    hand, pile: null, canPass: false, opponentCounts: [6, 1, 6],
    mySeat: 0, numPlayers: 4, pileOwner: null, handCounts: [3, 6, 1, 6], partnerSeat: 2,
  };
  for (const tier of TIERS) {
    const m = decideBotMove(view, tier);
    assert.deepEqual(m.action === 'play' && m.cards, [c('3', 'S')], `${tier} should lead low to free the partner`);
  }
});

test('2v2 team: withholds the low lead when the NEXT opponent is also about to finish (cunning guard)', () => {
  const hand = [c('3', 'S'), c('9', 'H')];
  // Partner (seat 2) has 1 card, BUT the next opponent (seat 1) ALSO has 1 → don't gift them the trick:
  // Rule B is suppressed and the bot falls back to normal play (still legal; just not the forced low feed).
  const view: BotView = {
    hand, pile: null, canPass: false, opponentCounts: [1, 1, 6],
    mySeat: 0, numPlayers: 4, pileOwner: null, handCounts: [2, 1, 1, 6], partnerSeat: 2,
  };
  const m = decideBotMove(view, 'easy');
  assert.equal(m.action, 'play'); // a leader always plays; the guard just prevented the unconditional feed
});

test('hard uses card memory to lead a lock single (both jokers already played)', () => {
  const hand = [c('2', 'S'), c('3', 'H')]; // the 2 is the top non-joker single
  const seen: Card[] = [{ kind: 'joker', color: 'red' }, { kind: 'joker', color: 'black' }];
  const view: BotView = { hand, pile: null, canPass: false, opponentCounts: [5], seen };
  // Nothing unseen out-ranks a 2 as a single (both jokers are gone) → lead it to keep the lead.
  assert.deepEqual(decideBotMove(view, 'hard'), { action: 'play', cards: [c('2', 'S')] });
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
