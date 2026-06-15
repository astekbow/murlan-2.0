// ============================================================================
// MURLAN — TRON deposit-address SCANNER (RUN LOCALLY / OFFLINE-ish)
// ----------------------------------------------------------------------------
// The server gives every player a UNIQUE deposit address at m/44'/195'/0'/0/<index>
// (index 0,1,2,…). TronLink's "Add Account" walks a DIFFERENT path, so it can't show
// these. This script derives the SAME addresses the server does, reads each one's
// on-chain USDT balance, and prints the PRIVATE KEY of any funded address so you can
// import it into TronLink ("Import wallet → Private Key") to access/move the funds.
//
// It needs your SEED (the 24-word mnemonic that matches TRON_DEPOSIT_XPUB). It only
// READS balances from TronGrid + derives keys locally — it NEVER sends anything.
//
// SETUP (in this tools/ folder, one time — same deps as tron-xpub.mjs):
//   npm i @scure/bip32 @scure/bip39 @noble/curves @noble/hashes bs58
//
// RUN (prefer the env var so the seed isn't saved in your shell history):
//   MNEMONIC="word1 word2 … word24" node tron-scan.mjs            # scans indexes 0..29
//   MNEMONIC="…" COUNT=60 node tron-scan.mjs                       # scan more indexes
//   MNEMONIC="…" TRONGRID_API_KEY=xxxx node tron-scan.mjs          # higher rate limit
//   node tron-scan.mjs "word1 word2 … word24"                     # (seed via argument)
//
// ⚠️ The printed PRIVATE KEYS control real money. Run on YOUR machine, don't screenshot
//    or paste them anywhere, and clear your terminal afterwards.
// ============================================================================

import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

const ACCOUNT_PATH = "m/44'/195'/0'/0";
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // mainnet USDT-TRC20
const API = 'https://api.trongrid.io';

/** secp256k1 compressed pubkey → TRON base58check address (T...). Same as tron-xpub.mjs. */
function pubkeyToTronAddress(pubkeyCompressed) {
  const uncompressed = secp256k1.Point.fromBytes(pubkeyCompressed).toBytes(false);
  const hash = keccak_256(uncompressed.slice(1));
  const addr21 = new Uint8Array(21);
  addr21[0] = 0x41;
  addr21.set(hash.slice(-20), 1);
  const checksum = sha256(sha256(addr21)).slice(0, 4);
  const full = new Uint8Array(25);
  full.set(addr21, 0);
  full.set(checksum, 21);
  return bs58.encode(full);
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Read an address's USDT-TRC20 balance (in whole USDT) from TronGrid, or null on error. */
async function usdtBalance(address, apiKey) {
  try {
    const res = await fetch(`${API}/v1/accounts/${address}`, apiKey ? { headers: { 'TRON-PRO-API-KEY': apiKey } } : {});
    if (!res.ok) return null;
    const data = await res.json();
    const acct = (data?.data ?? [])[0];
    if (!acct) return 0; // never activated → empty
    for (const entry of (Array.isArray(acct.trc20) ? acct.trc20 : [])) {
      const v = entry?.[USDT_CONTRACT];
      if (v != null) return Number(v) / 1e6; // USDT has 6 decimals
    }
    return 0;
  } catch {
    return null;
  }
}

const mnemonic = (process.env.MNEMONIC || process.argv.slice(2).join(' ')).trim();
if (!mnemonic) {
  console.error('\n❌ No seed. Run:  MNEMONIC="your 24 words" node tron-scan.mjs\n');
  process.exit(1);
}
if (!bip39.validateMnemonic(mnemonic, wordlist)) {
  console.error('\n❌ That is not a valid BIP39 mnemonic (check the words/order).\n');
  process.exit(1);
}
const COUNT = Math.max(1, Math.min(500, Number(process.env.COUNT || 30)));
const apiKey = process.env.TRONGRID_API_KEY || null;

const account = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derive(ACCOUNT_PATH);

console.log('\n========================================================================');
console.log(` TRON DEPOSIT SCAN — indexes 0..${COUNT - 1}  (path ${ACCOUNT_PATH}/<index>)`);
console.log('========================================================================');
console.log(' Verify: index 0 + 1 must match what the server DB shows for your players.\n');

let total = 0;
const funded = [];
for (let i = 0; i < COUNT; i++) {
  const child = account.deriveChild(i);
  const address = pubkeyToTronAddress(child.publicKey);
  let bal = await usdtBalance(address, apiKey);
  if (bal == null) { await new Promise((r) => setTimeout(r, 900)); bal = await usdtBalance(address, apiKey); } // one retry on a rate-limit/blip
  const shown = bal == null ? '   (read error — re-run, ideally with TRONGRID_API_KEY)' : `${bal.toFixed(2)} USDT`;
  console.log(`  #${String(i).padStart(3)}  ${address}  ${shown}`);
  if (bal && bal > 0) {
    total += bal;
    funded.push({ i, address, privKey: toHex(child.privateKey) });
  }
  await new Promise((r) => setTimeout(r, apiKey ? 150 : 400)); // gentle on TronGrid's rate limit (slower without a key)
}

console.log('\n------------------------------------------------------------------------');
console.log(` TOTAL USDT across scanned addresses: ${total.toFixed(2)} USDT`);
console.log('------------------------------------------------------------------------');

if (funded.length === 0) {
  console.log('\n No funded addresses in this range. If you expected funds:');
  console.log('  • raise COUNT (e.g. COUNT=100) — the player may be at a higher index, or');
  console.log('  • the seed does NOT match the server xpub (wrong wallet).\n');
} else {
  console.log('\n FUNDED ADDRESSES — import the PRIVATE KEY into TronLink (Import wallet →');
  console.log(' Private Key) to access/send the USDT.  ⚠️ KEEP THESE SECRET.\n');
  for (const f of funded) {
    console.log(`  #${f.i}  ${f.address}`);
    console.log(`        privateKey: ${f.privKey}\n`);
  }
  console.log(' To fund payouts: send this USDT to your Binance USDT-TRC20 deposit address.');
  console.log(' (Each address needs a little TRX for the transfer fee.)\n');
}
