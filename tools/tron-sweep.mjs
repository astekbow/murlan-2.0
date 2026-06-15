// ============================================================================
// MURLAN — TRON deposit SWEEP (RUN LOCALLY / OFFLINE machine)
// ----------------------------------------------------------------------------
// Consolidates the USDT sitting in your per-player deposit addresses
// (m/44'/195'/0'/0/<index>) into ONE destination (e.g. your Binance USDT-TRC20
// deposit address), in a single run — instead of importing each key by hand.
//
// A USDT-TRC20 transfer needs the SENDING address to hold a little TRX for the fee,
// and deposit addresses hold only USDT — so for each funded address the script first
// sends a bit of TRX from YOUR gas wallet, then transfers the USDT out.
//
// SAFETY: it's a DRY RUN by default (shows the plan, moves NOTHING). It only moves
// money when you pass EXECUTE=yes. Private keys are derived locally and never leave
// the machine. Run on YOUR computer, not the server.
//
// SETUP (in tools/, one time):
//   npm i tronweb @scure/bip32 @scure/bip39
//
// DRY RUN (see what it WOULD sweep — safe, recommended first):
//   $env:MNEMONIC = Read-Host "Seed"
//   $env:DEST = "<your Binance USDT-TRC20 deposit address>"
//   $env:GAS_PRIVATE_KEY = "<priv key of a wallet holding ~50+ TRX for fees>"
//   $env:TRONGRID_API_KEY = "<optional>"
//   node tron-sweep.mjs
//
// EXECUTE (actually move the money):
//   $env:EXECUTE = "yes"; node tron-sweep.mjs ; $env:EXECUTE=$null ; $env:MNEMONIC=$null ; $env:GAS_PRIVATE_KEY=$null
//
// Tunables (env): COUNT (indexes to scan, default 40), GAS_TRX (TRX sent per address
// for the fee, default 35), MIN_USDT (skip dust below this, default 0.5).
// ============================================================================

import TronWebPkg from 'tronweb';
import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const TronWeb = TronWebPkg.TronWeb ?? TronWebPkg.default ?? TronWebPkg; // v5/v6 interop

const FULL_HOST = 'https://api.trongrid.io';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ACCOUNT_PATH = "m/44'/195'/0'/0";
const TRC20_ABI = [
  { constant: true, inputs: [{ name: 'who', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: false, inputs: [{ name: '_to', type: 'address' }, { name: '_value', type: 'uint256' }], name: 'transfer', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
];

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- inputs --------------------------------------------------------------
const mnemonic = (process.env.MNEMONIC || '').trim();
const DEST = (process.env.DEST || '').trim();
const GAS_PK = (process.env.GAS_PRIVATE_KEY || '').trim().replace(/^0x/, '');
const apiKey = process.env.TRONGRID_API_KEY || null;
const COUNT = Math.max(1, Math.min(500, Number(process.env.COUNT || 40)));
const GAS_TRX = Number(process.env.GAS_TRX || 35);
const MIN_USDT = Number(process.env.MIN_USDT || 0.5);
const EXECUTE = process.env.EXECUTE === 'yes';

function die(msg) { console.error(`\n❌ ${msg}\n`); process.exit(1); }
if (!mnemonic) die('Set MNEMONIC (the deposit-wallet seed).');
if (!bip39.validateMnemonic(mnemonic, wordlist)) die('MNEMONIC is not a valid BIP39 phrase.');
const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
const reader = new TronWeb({ fullHost: FULL_HOST, headers });
if (!reader.isAddress(DEST)) die('Set DEST to a valid TRON USDT-TRC20 address (your Binance deposit address).');
reader.setAddress(DEST); // a constant balanceOf() call needs an owner_address set, even read-only
if (EXECUTE && (!GAS_PK || GAS_PK.length !== 64)) die('EXECUTE needs GAS_PRIVATE_KEY = the 64-hex private key of a wallet holding TRX for fees.');

const account = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derive(ACCOUNT_PATH);
const usdtRead = reader.contract(TRC20_ABI, USDT);

console.log('\n========================================================================');
console.log(` TRON SWEEP  →  ${DEST}`);
console.log(`  mode: ${EXECUTE ? '⚠️  EXECUTE (will move funds)' : 'DRY RUN (no funds moved)'}  ·  scanning indexes 0..${COUNT - 1}`);
console.log('========================================================================\n');

// ---- 1) find funded addresses -------------------------------------------
const funded = [];
for (let i = 0; i < COUNT; i++) {
  const pk = toHex(account.deriveChild(i).privateKey);
  const address = TronWeb.address.fromPrivateKey(pk);
  let usdt = null;
  try { usdt = Number(await usdtRead.balanceOf(address).call()) / 1e6; }
  catch (e) { console.log(`  #${i} ${address}  ⚠️ read error (re-run to be safe): ${String(e).slice(0, 70)}`); }
  if (usdt != null && usdt >= MIN_USDT) {
    funded.push({ i, address, pk, usdt });
    console.log(`  #${i}  ${address}  ${usdt.toFixed(2)} USDT  → will sweep`);
  }
  await sleep(apiKey ? 150 : 400);
}
const total = funded.reduce((s, f) => s + f.usdt, 0);
console.log(`\n  Funded addresses: ${funded.length}   Total: ${total.toFixed(2)} USDT`);
console.log(`  Estimated gas: up to ${(funded.length * GAS_TRX)} TRX (${GAS_TRX} TRX × ${funded.length}) from your gas wallet.\n`);

if (funded.length === 0) { console.log('Nothing to sweep.\n'); process.exit(0); }
if (!EXECUTE) {
  console.log('DRY RUN — nothing moved. To actually sweep, re-run with EXECUTE=yes (and GAS_PRIVATE_KEY set).\n');
  process.exit(0);
}

// ---- 2) execute: gas-up then transfer USDT, per address ------------------
const gas = new TronWeb({ fullHost: FULL_HOST, headers, privateKey: GAS_PK });
const gasAddr = gas.address.fromPrivateKey(GAS_PK);
console.log(`Gas wallet: ${gasAddr}\n`);
let ok = 0; let swept = 0;
for (const f of funded) {
  try {
    const needSun = Math.round(GAS_TRX * 1e6);
    const haveSun = await reader.trx.getBalance(f.address);
    if (haveSun < needSun) {
      console.log(`  #${f.i} sending ${GAS_TRX} TRX for gas…`);
      await gas.trx.sendTransaction(f.address, needSun - haveSun);
      // wait for the TRX to land before spending it
      for (let t = 0; t < 20; t++) { await sleep(3000); if ((await reader.trx.getBalance(f.address)) >= needSun) break; }
    }
    const sender = new TronWeb({ fullHost: FULL_HOST, headers, privateKey: f.pk });
    const usdt = sender.contract(TRC20_ABI, USDT);
    const raw = BigInt(await usdt.balanceOf(f.address).call()); // re-read exact raw balance
    if (raw <= 0n) { console.log(`  #${f.i} now empty, skipping`); continue; }
    const txid = await usdt.transfer(DEST, raw.toString()).send({ feeLimit: 100_000_000 }); // 100 TRX cap
    console.log(`  #${f.i} ✅ sent ${(Number(raw) / 1e6).toFixed(2)} USDT → ${DEST}  tx ${txid}`);
    ok++; swept += Number(raw) / 1e6;
    await sleep(2000);
  } catch (e) {
    console.log(`  #${f.i} ⚠️ FAILED: ${String(e).slice(0, 160)} (others continue)`);
  }
}
console.log(`\n========================================================================`);
console.log(` DONE — swept ${swept.toFixed(2)} USDT from ${ok}/${funded.length} addresses → ${DEST}`);
console.log('========================================================================\n');
