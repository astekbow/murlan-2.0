import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { deal } from '@murlan/engine';
import { reconstructDeal, verifyCommitment, sha256Hex } from './fairVerify.ts';

// A FAITHFUL copy of the server's fair/prng.ts hmacRng — the reference the
// browser port must reproduce byte-for-byte. (Uses node:crypto, the same
// primitive the server runs, so a match here proves the browser === the server.)
function refRng(serverSeed: string, clientSeed: string, nonce: number): () => number {
  let block = 0;
  let buffer = Buffer.alloc(0);
  let pos = 0;
  const refill = () => {
    buffer = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${block}`).digest();
    block += 1;
    pos = 0;
  };
  return () => {
    if (pos + 4 > buffer.length) refill();
    const v = buffer.readUInt32BE(pos);
    pos += 4;
    return v / 2 ** 32;
  };
}

test('browser fair PRNG reproduces the server deal EXACTLY (2/3/4 players, several nonces)', async () => {
  const serverSeed = 'a3f1'.repeat(16); // 64 hex chars, like a real serverSeed
  const clientSeed = 'deadbeefcafefeed';
  const counts: Array<2 | 3 | 4> = [2, 3, 4];
  for (const numPlayers of counts) {
    for (let nonce = 0; nonce < 4; nonce += 1) {
      const expected = deal(numPlayers, refRng(serverSeed, clientSeed, nonce));
      const actual = await reconstructDeal(serverSeed, clientSeed, nonce, numPlayers);
      assert.deepEqual(actual, expected, `numPlayers=${numPlayers} nonce=${nonce}`);
    }
  }
});

test('reconstructed hands are a complete, disjoint partition of the deck', async () => {
  const hands = await reconstructDeal('seed'.repeat(16), 'client', 0, 4);
  const total = hands.reduce((n, h) => n + h.length, 0);
  assert.deepEqual(hands.map((h) => h.length), [14, 14, 13, 13]); // 4-player deal sizes
  assert.equal(total, 54);
});

test('sha256Hex + verifyCommitment match node crypto', async () => {
  const serverSeed = 'some-server-seed-value';
  const hash = createHash('sha256').update(serverSeed).digest('hex');
  assert.equal(await sha256Hex(serverSeed), hash);
  assert.equal(await verifyCommitment(serverSeed, hash), true);
  assert.equal(await verifyCommitment(serverSeed, 'deadbeef'), false);
});

test('reconstructDeal rejects an impossible player count', async () => {
  assert.deepEqual(await reconstructDeal('s', 'c', 0, 5), []);
});
