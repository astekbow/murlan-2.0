import test from 'node:test';
import assert from 'node:assert/strict';
import { cardId } from '@murlan/engine';
import { hmacRng } from './prng.ts';
import {
  createFairShuffle, verifyDeal, verifyCommitment, sha256Hex, combineClientSeeds, generateServerSeed,
} from './provablyFair.ts';

const handsKey = (hands: { length: number } & any[][]) =>
  hands.map((h) => h.map(cardId).join(',')).join('|');

test('hmacRng is deterministic for the same (serverSeed, clientSeed, nonce)', () => {
  const a = hmacRng('srv', 'cli', 0);
  const b = hmacRng('srv', 'cli', 0);
  const seqA = Array.from({ length: 100 }, () => a());
  const seqB = Array.from({ length: 100 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

test('hmacRng diverges with a different nonce/seed', () => {
  const base = Array.from({ length: 20 }, hmacRng('srv', 'cli', 0));
  const diffNonce = Array.from({ length: 20 }, hmacRng('srv', 'cli', 1));
  const diffSeed = Array.from({ length: 20 }, hmacRng('srv2', 'cli', 0));
  assert.notDeepEqual(base, diffNonce);
  assert.notDeepEqual(base, diffSeed);
});

test('the committed hash matches the revealed serverSeed', () => {
  const fair = createFairShuffle(4);
  const { serverSeedHash } = fair.commitment();
  const revealed = fair.reveal();
  assert.equal(serverSeedHash, revealed.serverSeedHash);
  assert.equal(sha256Hex(revealed.serverSeed), serverSeedHash);
  assert.ok(verifyCommitment(revealed.serverSeed, serverSeedHash));
});

test('a player can recompute every dealt game from the revealed seeds', () => {
  const fair = createFairShuffle(3, 'player-supplied-seed');
  const g0 = fair.deal();
  const g1 = fair.deal();
  const reveal = fair.reveal();
  assert.equal(reveal.gameCount, 2);

  // Independent recomputation must reproduce the EXACT deals.
  assert.equal(handsKey(verifyDeal(reveal.serverSeed, reveal.clientSeed, 0, 3) as any), handsKey(g0 as any));
  assert.equal(handsKey(verifyDeal(reveal.serverSeed, reveal.clientSeed, 1, 3) as any), handsKey(g1 as any));
});

test('a tampered serverSeed fails the commitment check and produces a different deal', () => {
  const fair = createFairShuffle(2, 'seed');
  const g0 = fair.deal();
  const reveal = fair.reveal();
  const tampered = reveal.serverSeed.replace(/^./, (ch) => (ch === 'a' ? 'b' : 'a'));
  assert.equal(verifyCommitment(tampered, reveal.serverSeedHash), false);
  assert.notEqual(handsKey(verifyDeal(tampered, reveal.clientSeed, 0, 2) as any), handsKey(g0 as any));
});

test('each dealt game uses all 54 cards with no duplicates', () => {
  const fair = createFairShuffle(4);
  const hands = fair.deal();
  const all = hands.flat();
  assert.equal(all.length, 54);
  assert.equal(new Set(all.map(cardId)).size, 54);
});

test('a pre-committed serverSeed is used as-is (commit-before-clientSeed flow)', () => {
  const { serverSeed, serverSeedHash } = generateServerSeed();
  assert.equal(sha256Hex(serverSeed), serverSeedHash);
  // Using the committed serverSeed reproduces the same hash and a verifiable deal.
  const fair = createFairShuffle(2, 'late-client-seed', serverSeed);
  assert.equal(fair.serverSeed, serverSeed);
  assert.equal(fair.commitment().serverSeedHash, serverSeedHash);
  const g0 = fair.deal();
  const recomputed = verifyDeal(serverSeed, 'late-client-seed', 0, 2);
  assert.equal(handsKey(recomputed as any), handsKey(g0 as any));
});

test('combineClientSeeds is order-independent and reproducible', () => {
  assert.equal(combineClientSeeds(['b', 'a']), combineClientSeeds(['a', 'b']));
  assert.equal(combineClientSeeds(['a', 'b']), sha256Hex('a|b'));
});
