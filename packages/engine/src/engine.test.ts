import type { Card } from './engine.ts';
import {
  identifyCombo, beats, validatePlay, buildDeck, deal, dealSizes,
} from './engine.ts';

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

// helpers to build cards quickly
const c = (rank: any, suit: any): Card => ({ kind: 'standard', rank, suit });
const BJ: Card = { kind: 'joker', color: 'black' };
const RJ: Card = { kind: 'joker', color: 'red' };

// beats helper that identifies both sides first
function B(cand: Card[], cur: Card[]): boolean {
  const a = identifyCombo(cand)!, b = identifyCombo(cur)!;
  return beats(a, b);
}

console.log('\n— SINGLE power order (3 < ... < K < A < 2 < BJ < RJ) —');
check('4 beats 3', B([c('4','S')], [c('3','H')]));
check('2 beats K', B([c('2','S')], [c('K','H')]));
check('2 beats A', B([c('2','S')], [c('A','H')]));
check('black joker beats 2', B([BJ], [c('2','H')]));
check('red joker beats black joker', B([RJ], [BJ]));
check('3 does NOT beat 4', !B([c('3','S')], [c('4','H')]));

console.log('\n— PAIRS / TRIPLES —');
check('pair of 4s beats pair of 3s', B([c('4','S'),c('4','H')], [c('3','S'),c('3','H')]));
check('two jokers are NOT a valid pair', identifyCombo([BJ, RJ]) === null);
check('mixed pair invalid', identifyCombo([c('4','S'), c('5','H')]) === null);
check('triple 5s beats triple 4s', B([c('5','S'),c('5','H'),c('5','D')], [c('4','S'),c('4','H'),c('4','D')]));
check('pair cannot beat a triple (category)', !B([c('2','S'),c('2','H')], [c('3','S'),c('3','H'),c('3','D')]));

console.log('\n— BOMB (four of a kind) —');
const bomb5 = [c('5','S'),c('5','H'),c('5','D'),c('5','C')];
const bomb6 = [c('6','S'),c('6','H'),c('6','D'),c('6','C')];
check('four 5s is a bomb', identifyCombo(bomb5)?.type === 'bomb');
check('four 6s beats four 5s', B(bomb6, bomb5));
check('four 5s does NOT beat four 6s', !B(bomb5, bomb6));
check('bomb beats a single red joker', B(bomb5, [RJ]));
check('bomb beats a triple', B(bomb5, [c('A','S'),c('A','H'),c('A','D')]));
check('bomb beats a pair', B(bomb5, [c('2','S'),c('2','H')]));

console.log('\n— KOLOR (mixed-suit straight, length >= 5) —');
const k3_7 = [c('3','S'),c('4','H'),c('5','D'),c('6','C'),c('7','S')]; // mixed suits
const k4_8 = [c('4','D'),c('5','C'),c('6','S'),c('7','H'),c('8','D')];
const k10_A = [c('10','S'),c('J','H'),c('Q','D'),c('K','C'),c('A','S')];
const kA_5  = [c('A','S'),c('2','H'),c('3','D'),c('4','C'),c('5','S')];
const k3_8  = [c('3','S'),c('4','H'),c('5','D'),c('6','C'),c('7','S'),c('8','H')]; // length 6
check('3->7 is a kolor', identifyCombo(k3_7)?.type === 'kolor');
check('4->8 beats 3->7 (same length, +1 rank)', B(k4_8, k3_7));
check('A2345 is the lowest kolor', identifyCombo(kA_5)?.type === 'kolor');
check('10JQKA is a valid kolor (Ace high)', identifyCombo(k10_A)?.type === 'kolor');
check('no same-length kolor beats 10JQKA', !B(k4_8, k10_A) && !B(k3_7, k10_A));
// RUN LENGTH RULE: a run is beaten ONLY by a same-length run with a higher top.
check('a LONGER kolor does NOT beat a shorter one (same length only)', !B(k3_8, k10_A));
check('a SHORTER kolor does NOT beat a longer one', !B(k10_A, k3_8));
check('JQKA2 is NOT a valid straight', identifyCombo([c('J','S'),c('Q','H'),c('K','D'),c('A','C'),c('2','S')]) === null);
check('bomb beats a kolor', B(bomb6, k3_7));
check('kolor cannot beat a bomb', !B(k4_8, bomb5));

console.log('\n— KOLOR +1 RULE: beaten ONLY by the IMMEDIATE next run (same length, top exactly +1) —');
const k5_9 = [c('5','S'),c('6','H'),c('7','D'),c('8','C'),c('9','S')]; // top 9
const k8_Q = [c('8','S'),c('9','H'),c('10','D'),c('J','C'),c('Q','S')]; // top 12
const k23456 = [c('2','S'),c('3','H'),c('4','D'),c('5','C'),c('6','S')]; // top 6
// 9-card runs (the owner's "4–Q can only be beaten by 5–K" example):
const k4_Q = [c('4','S'),c('5','H'),c('6','D'),c('7','C'),c('8','S'),c('9','H'),c('10','D'),c('J','C'),c('Q','S')]; // top 12
const k5_K = [c('5','D'),c('6','C'),c('7','S'),c('8','H'),c('9','D'),c('10','C'),c('J','S'),c('Q','H'),c('K','D')]; // top 13
const k6_A = [c('6','D'),c('7','C'),c('8','S'),c('9','H'),c('10','D'),c('J','C'),c('Q','S'),c('K','H'),c('A','D')]; // top 14
check('5->9 does NOT beat 3->7 (gap of 2)', !B(k5_9, k3_7));
check('8->Q does NOT beat 3->7 (the owner\'s example — unrelated higher run)', !B(k8_Q, k3_7));
check('5->9 beats 4->8 (+1)', B(k5_9, k4_8));
check('4->8 does NOT beat 4->8 (not higher)', !B(k4_8, k4_8));
check('23456 beats A2345 (+1)', B(k23456, kA_5));
check('3->7 does NOT beat A2345 (gap of 2, was wrongly allowed before)', !B(k3_7, kA_5));
check('long run: 5->K beats 4->Q (+1)', B(k5_K, k4_Q));
check('long run: 6->A does NOT beat 4->Q (gap of 2)', !B(k6_A, k4_Q));
check('long run: a same-length non-adjacent higher run never beats', !B(k6_A, k4_Q) && B(k5_K, k4_Q));

console.log('\n— FLUSH (same-suit straight) — strongest —');
const f3_7 = [c('3','S'),c('4','S'),c('5','S'),c('6','S'),c('7','S')];
const f4_8 = [c('4','H'),c('5','H'),c('6','H'),c('7','H'),c('8','H')];
const f3_8 = [c('3','D'),c('4','D'),c('5','D'),c('6','D'),c('7','D'),c('8','D')];
check('3->7 same suit is a flush, not kolor', identifyCombo(f3_7)?.type === 'flush');
check('flush 4->8 beats flush 3->7', B(f4_8, f3_7));
check('flush beats a bomb (always)', B(f3_7, bomb6));
check('even the smallest flush beats the biggest bomb', B(f3_7, [c('2','S'),c('2','H'),c('2','D'),c('2','C')]));
check('flush beats a kolor', B(f3_7, k10_A));
check('bomb does NOT beat a flush', !B(bomb6, f3_7));
// Same-length rule applies flush-vs-flush too: a longer flush can NOT beat a shorter one.
check('a longer flush does NOT beat a shorter flush (same length only)', !B(f3_8, f4_8));
check('a shorter flush does NOT beat a longer flush', !B(f4_8, f3_8));
check('flush beats red joker', B(f3_7, [RJ]));

console.log('\n— validatePlay (leading vs responding) —');
check('any valid combo may lead', validatePlay(k3_7, null).ok === true);
check('invalid combo rejected when leading', validatePlay([c('3','S'),c('5','H')], null).ok === false);
check('weaker single rejected vs current', validatePlay([c('3','S')], identifyCombo([c('5','H')])).ok === false);
check('bomb accepted over a single', validatePlay(bomb5, identifyCombo([c('A','S')])).ok === true);

console.log('\n— Deck & dealing —');
const deck = buildDeck();
check('deck has 54 cards', deck.length === 54);
check('deck has 2 jokers', deck.filter(x => x.kind === 'joker').length === 2);
check('no duplicate cards', new Set(deck.map(x => x.kind==='joker'?`J${x.color}`:`${x.rank}${x.suit}`)).size === 54);
check('2-player deal = 18/18', JSON.stringify(dealSizes(2)) === '[18,18]');
check('2-player deal leaves 18 cards undealt', 54 - dealSizes(2).reduce((a,b)=>a+b,0) === 18);
check('3-player deal = 18/18/18', JSON.stringify(dealSizes(3)) === '[18,18,18]');
check('4-player deal = 14/14/13/13', JSON.stringify(dealSizes(4)) === '[14,14,13,13]');
let seed = 12345; const rng = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const hands = deal(4, rng);
check('4-player deal uses all 54 cards', hands.flat().length === 54);

console.log(`\n========== ${pass} passed, ${fail} failed ==========\n`);
if (fail > 0) process.exit(1);
