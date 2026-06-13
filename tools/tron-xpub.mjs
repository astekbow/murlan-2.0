// ============================================================================
// MURLAN — TRON deposit-wallet xpub generator (RUN LOCALLY, IDEALLY OFFLINE)
// ----------------------------------------------------------------------------
// Generates a DEDICATED TRON wallet for crediting player deposits, and prints:
//   • the 24-word MNEMONIC  → write on paper, store in a safe (COLD storage).
//   • the account XPUB       → paste into the server (TRON_DEPOSIT_XPUB).
//
// The server uses ONLY the xpub — it derives each player's unique deposit
// address but can NEVER move funds (no private keys on the server = no custody
// risk if the VPS is breached). You move/consolidate funds later by importing
// this mnemonic into a TRON wallet (TronLink/Ledger) — that's the only time it's used.
//
// ⚠️  SECURITY:
//   • Do NOT use your existing Ledger/Trezor seed here — generate a fresh one (default).
//   • Run on a trusted machine; ideally DISCONNECT the internet first.
//   • This seed controls all deposited USDT — back it up like real money.
//   • Never paste the mnemonic anywhere online or onto the server. Only the xpub.
//
// SETUP (one time, in this tools/ folder):
//   npm init -y
//   npm i @scure/bip32 @scure/bip39 @noble/curves @noble/hashes bs58
//
// RUN:
//   node tron-xpub.mjs                 # generate a NEW dedicated wallet
//   node tron-xpub.mjs "word1 word2 …" # OR re-derive the xpub from an existing
//                                      # DEDICATED mnemonic (never your Ledger seed)
// ============================================================================

import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

// TRON BIP44 account path (coin type 195). Children m/44'/195'/0'/0/{index} are
// the per-player deposit addresses; the xpub is taken at the .../0 level so the
// server can derive every child address from the public key alone.
const ACCOUNT_PATH = "m/44'/195'/0'/0";

/** secp256k1 public key (compressed, 33 bytes) → TRON base58check address (T...). */
export function pubkeyToTronAddress(pubkeyCompressed) {
  const uncompressed = secp256k1.Point.fromBytes(pubkeyCompressed).toBytes(false); // 65 bytes (0x04 || X || Y)
  const hash = keccak_256(uncompressed.slice(1));            // keccak256 of X||Y
  const addr21 = new Uint8Array(21);
  addr21[0] = 0x41;                                          // TRON mainnet prefix
  addr21.set(hash.slice(-20), 1);                            // last 20 bytes of the hash
  const checksum = sha256(sha256(addr21)).slice(0, 4);       // double-sha256 checksum
  const full = new Uint8Array(25);
  full.set(addr21, 0);
  full.set(checksum, 21);
  return bs58.encode(full);
}

const provided = process.argv.slice(2).join(' ').trim();
const mnemonic = provided || bip39.generateMnemonic(wordlist, 256); // 256 bits = 24 words
if (provided && !bip39.validateMnemonic(provided, wordlist)) {
  console.error('\n❌ That is not a valid BIP39 mnemonic. Omit the argument to generate a fresh one.\n');
  process.exit(1);
}

const seed = bip39.mnemonicToSeedSync(mnemonic);
const account = HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH);
const xpub = account.publicExtendedKey;

// Sanity-check: print the first 3 deposit addresses. The SERVER must derive the
// EXACT same addresses from the xpub — verify before sending any real money.
const sample = [0, 1, 2].map((i) => pubkeyToTronAddress(account.deriveChild(i).publicKey));

console.log('\n========================================================================');
console.log(' TRON DEPOSIT WALLET — KEEP THE MNEMONIC OFFLINE, SEND ONLY THE XPUB');
console.log('========================================================================\n');
if (!provided) {
  console.log('MNEMONIC (write on paper, store in a safe — this controls all deposits):\n');
  console.log('   ' + mnemonic + '\n');
}
console.log('XPUB (paste into the server as TRON_DEPOSIT_XPUB — safe to share with the dev):\n');
console.log('   ' + xpub + '\n');
console.log('Sanity-check addresses (player #0, #1, #2) — the server must match these:\n');
sample.forEach((a, i) => console.log(`   #${i}: ${a}`));
console.log('\nDerivation path: ' + ACCOUNT_PATH + "/<playerIndex>");
console.log('========================================================================\n');
