// ============================================================================
// MURLAN — Provably-fair verification (browser)
// ----------------------------------------------------------------------------
// Recomputes a match's deals IN THE BROWSER from the revealed seeds and checks
// them against the committed hash, so a player needs to trust nothing: they can
// see the server didn't change the seed after committing, and that every deal is
// a pure function of (serverSeed, clientSeed, nonce).
//
// This is a faithful port of the server's fair/prng.ts: a counter-mode
// HMAC-SHA256 stream, 4 bytes per draw as a big-endian uint32 in [0,1). The DECK
// + DEAL come from the shared @murlan/engine (the exact same code the server
// runs), so only the PRNG needs porting. Web Crypto is async, so we pre-generate
// enough HMAC blocks then expose a synchronous rng the engine can consume.
// ============================================================================

import { deal, type Card } from '@murlan/engine';

const enc = new TextEncoder();

// A 54-card Fisher–Yates shuffle makes 53 draws → 7 HMAC blocks (32 bytes each,
// 8 draws per block). 16 blocks (128 draws) is a generous, fixed safety margin.
const BLOCKS = 16;

async function hmacBlocks(serverSeed: string, clientSeed: string, nonce: number): Promise<DataView> {
  const key = await crypto.subtle.importKey('raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = new Uint8Array(BLOCKS * 32);
  for (let block = 0; block < BLOCKS; block += 1) {
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${clientSeed}:${nonce}:${block}`));
    out.set(new Uint8Array(sig), block * 32);
  }
  return new DataView(out.buffer);
}

/**
 * The server's rng reads 4 bytes per draw as a big-endian uint32 and never
 * straddles a 32-byte block (32 is a clean multiple of 4), so a flat
 * concatenation read sequentially reproduces the exact same stream.
 */
async function fairRng(serverSeed: string, clientSeed: string, nonce: number): Promise<() => number> {
  const view = await hmacBlocks(serverSeed, clientSeed, nonce);
  let pos = 0;
  return () => {
    const v = view.getUint32(pos, false); // big-endian
    pos += 4;
    return v / 2 ** 32; // [0, 1)
  };
}

/** Recompute one game's deal from the revealed seeds (mirror of server verifyDeal). */
export async function reconstructDeal(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
  numPlayers: number,
): Promise<Card[][]> {
  if (numPlayers !== 2 && numPlayers !== 3 && numPlayers !== 4) return [];
  return deal(numPlayers, await fairRng(serverSeed, clientSeed, nonce));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True iff the revealed serverSeed hashes to the commitment shown before play. */
export async function verifyCommitment(serverSeed: string, serverSeedHash: string): Promise<boolean> {
  return (await sha256Hex(serverSeed)) === serverSeedHash;
}
