// ============================================================================
// MURLAN — Local SWEEP APP (a tiny localhost web app for your own PC)
// ----------------------------------------------------------------------------
// A click-to-use front-end over the SAME logic as tron-sweep.mjs: enter the seed,
// Scan to see balances, Dry-run to preview, then SWEEP to consolidate the USDT in
// your per-player deposit addresses → your Binance USDT-TRC20 address.
//
// ⚠️ RUN ON YOUR OWN COMPUTER ONLY. NEVER deploy this, never run it on the server,
//    never expose it. It binds to 127.0.0.1 (localhost) so ONLY this machine can
//    reach it. The seed + private keys are typed in the page, sent to this LOCAL
//    process, held only in memory for the request, and NEVER written to disk or
//    sent anywhere else. Close the app + the tab when done.
//
// SETUP (one time, in this tools/ folder):
//   npm i tronweb @scure/bip32 @scure/bip39
// RUN:
//   node sweep-app.mjs           (or double-click sweep-app.bat on Windows)
//   → open the printed http://127.0.0.1:8787 in your browser
// ============================================================================

import http from 'node:http';
import { exec } from 'node:child_process';
import TronWebPkg from 'tronweb';
import { HDKey } from '@scure/bip32';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const TronWeb = TronWebPkg.TronWeb ?? TronWebPkg.default ?? TronWebPkg; // v5/v6 interop

const FULL_HOST = 'https://api.trongrid.io';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // mainnet USDT-TRC20
const ACCOUNT_PATH = "m/44'/195'/0'/0";
const TRC20_ABI = [
  { constant: true, inputs: [{ name: 'who', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { constant: false, inputs: [{ name: '_to', type: 'address' }, { name: '_value', type: 'uint256' }], name: 'transfer', outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
];
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1'; // localhost ONLY — never 0.0.0.0

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeReader(apiKey) {
  const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  return { reader: new TronWeb({ fullHost: FULL_HOST, headers }), headers };
}

/** Derive the account node from a validated mnemonic. */
function deriveAccount(mnemonic) {
  return HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derive(ACCOUNT_PATH);
}

/** Read USDT balances of indexes 0..count-1; returns funded[] (>= minUsdt). */
async function scanFunded({ account, reader, headers, count, minUsdt, apiKey, log }) {
  const usdtRead = reader.contract(TRC20_ABI, USDT);
  const funded = [];
  for (let i = 0; i < count; i++) {
    const pk = toHex(account.deriveChild(i).privateKey);
    const address = TronWeb.address.fromPrivateKey(pk);
    let usdt = null;
    try { usdt = Number(await usdtRead.balanceOf(address).call()) / 1e6; }
    catch (e) { log(`#${i} ${address}  ⚠️ read error (re-run): ${String(e).slice(0, 70)}`); }
    if (usdt != null && usdt >= minUsdt) {
      funded.push({ i, address, pk, usdt });
      log(`#${i}  ${address}  ${usdt.toFixed(2)} USDT  → will sweep`);
    }
    await sleep(apiKey ? 150 : 400);
  }
  return funded;
}

/** Execute: gas-up each funded address from the gas wallet, then transfer its USDT
 *  to DEST. Mirrors tron-sweep.mjs exactly. Per-address try/catch so one failure
 *  doesn't stop the rest. */
async function sweepExecute({ funded, dest, gasPk, gasTrx, reader, headers, log }) {
  const gas = new TronWeb({ fullHost: FULL_HOST, headers, privateKey: gasPk });
  const gasAddr = gas.address.fromPrivateKey(gasPk);
  log(`Gas wallet: ${gasAddr}`);
  let ok = 0; let swept = 0;
  for (const f of funded) {
    try {
      const needSun = Math.round(gasTrx * 1e6);
      const haveSun = await reader.trx.getBalance(f.address);
      if (haveSun < needSun) {
        log(`#${f.i} sending ${gasTrx} TRX for gas…`);
        await gas.trx.sendTransaction(f.address, needSun - haveSun);
        for (let t = 0; t < 20; t++) { await sleep(3000); if ((await reader.trx.getBalance(f.address)) >= needSun) break; }
      }
      const sender = new TronWeb({ fullHost: FULL_HOST, headers, privateKey: f.pk });
      const usdt = sender.contract(TRC20_ABI, USDT);
      const raw = BigInt(await usdt.balanceOf(f.address).call()); // re-read exact raw balance
      if (raw <= 0n) { log(`#${f.i} now empty, skipping`); continue; }
      const txid = await usdt.transfer(dest, raw.toString()).send({ feeLimit: 100_000_000 });
      log(`#${f.i} ✅ sent ${(Number(raw) / 1e6).toFixed(2)} USDT → ${dest}  tx ${txid}`);
      ok++; swept += Number(raw) / 1e6;
      await sleep(2000);
    } catch (e) {
      log(`#${f.i} ⚠️ FAILED: ${String(e).slice(0, 160)} (others continue)`);
    }
  }
  return { ok, swept, count: funded.length };
}

// ---- request helpers --------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
const ndjson = (res, obj) => res.write(JSON.stringify(obj) + '\n');

// ---- server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Defense-in-depth: only serve local requests (the 127.0.0.1 bind already ensures this).
  const ra = req.socket.remoteAddress || '';
  if (!ra.includes('127.0.0.1') && ra !== '::1') { res.writeHead(403).end('local only'); return; }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'POST' && (req.url === '/api/scan' || req.url === '/api/sweep')) {
    const body = await readBody(req);
    const execute = req.url === '/api/sweep' && body.execute === true;
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    const log = (msg) => ndjson(res, { type: 'log', msg });
    try {
      const mnemonic = String(body.mnemonic || '').trim();
      if (!bip39.validateMnemonic(mnemonic, wordlist)) { ndjson(res, { type: 'error', msg: 'Seed-i (mnemonic) nuk është i vlefshëm (24 fjalë BIP39).' }); return res.end(); }
      const apiKey = String(body.apiKey || '').trim() || null;
      const count = Math.max(1, Math.min(500, Number(body.count) || 60));
      const minUsdt = Math.max(0, Number(body.minUsdt) || 0);
      const gasTrx = Math.max(1, Number(body.gasTrx) || 35);
      const { reader, headers } = makeReader(apiKey);
      const account = deriveAccount(mnemonic);
      // A constant balanceOf() call needs an owner_address set; index-0 is always valid.
      reader.setAddress(TronWeb.address.fromPrivateKey(toHex(account.deriveChild(0).privateKey)));

      log(`Po skanoj indekset 0..${count - 1}…`);
      const funded = await scanFunded({ account, reader, headers, count, minUsdt, apiKey, log });
      const total = funded.reduce((s, f) => s + f.usdt, 0);
      ndjson(res, { type: 'scan', funded: funded.map(({ i, address, usdt }) => ({ i, address, usdt })), total });
      log(`Gjetën ${funded.length} adresa me fonde · Total: ${total.toFixed(2)} USDT`);

      if (!execute) { // scan-only OR dry-run
        if (funded.length) log(`Gaz i vlerësuar: deri ${funded.length * gasTrx} TRX (${gasTrx}×${funded.length}) nga wallet-i i gazit.`);
        ndjson(res, { type: 'done', dryRun: true, total, count: funded.length });
        return res.end();
      }

      // EXECUTE
      const dest = String(body.dest || '').trim();
      const gasPk = String(body.gasPk || '').trim().replace(/^0x/, '');
      if (!reader.isAddress(dest)) { ndjson(res, { type: 'error', msg: 'DEST nuk është adresë TRON e vlefshme (adresa jote Binance USDT-TRC20).' }); return res.end(); }
      if (gasPk.length !== 64) { ndjson(res, { type: 'error', msg: 'Çelësi i gazit duhet të jetë 64 hex (private key i wallet-it me TRX).' }); return res.end(); }
      if (funded.length === 0) { ndjson(res, { type: 'done', total: 0, count: 0 }); return res.end(); }
      log(`⚠️ EXECUTE — po lëviz fondet → ${dest}`);
      const result = await sweepExecute({ funded, dest, gasPk, gasTrx, reader, headers, log });
      log(`PËRFUNDOI — u mblodhën ${result.swept.toFixed(2)} USDT nga ${result.ok}/${result.count} adresa → ${dest}`);
      ndjson(res, { type: 'done', ...result });
      res.end();
    } catch (e) {
      ndjson(res, { type: 'error', msg: String(e).slice(0, 200) });
      res.end();
    }
    return;
  }

  res.writeHead(404).end('not found');
});

const PAGE = `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Murlan — Sweep</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0c0e12;color:#e8e6df;margin:0;padding:24px;line-height:1.5}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}.sub{color:#9aa;margin:0 0 16px;font-size:13px}
.warn{background:#3a1414;border:1px solid #7a2a2a;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:16px}
label{display:block;font-size:12px;color:#9aa;margin:10px 0 4px}
input,textarea{width:100%;background:#15181f;border:1px solid #2a2f3a;color:#e8e6df;border-radius:8px;padding:9px 11px;font-size:14px;font-family:inherit}
textarea{resize:vertical;min-height:64px}
.row{display:flex;gap:10px}.row>div{flex:1}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
button{border:0;border-radius:8px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer}
.scan{background:#1f2a44;color:#cfe0ff}.dry{background:#243a24;color:#cfeacb}.go{background:#7a1f1f;color:#ffd9d9}
button:disabled{opacity:.5;cursor:not-allowed}
.log{background:#0a0c10;border:1px solid #1c2029;border-radius:8px;padding:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;max-height:340px;overflow:auto;margin-top:14px}
.total{font-size:16px;font-weight:700;margin-top:10px}.hide{color:#9aa;font-size:12px;cursor:pointer;user-select:none}
</style></head><body><div class="wrap">
<h1>🧹 Murlan — Sweep depozitash → Binance</h1>
<p class="sub">Xhirohet vetëm në këtë PC. Seed-i s'del kurrë nga kompjuteri yt dhe s'ruhet kurrë.</p>
<div class="warn">⚠️ Mos e ngjit seed-in askund tjetër. Mbylle faqen + dritaren kur të mbarosh. Fillo gjithmonë me <b>Scan</b> → <b>Dry-run</b> → pastaj <b>SWEEP</b>.</div>

<label>Seed-i (24 fjalët) <span class="hide" id="toggle">[shfaq/fsheh]</span></label>
<textarea id="mnemonic" placeholder="fjala1 fjala2 … fjala24" autocomplete="off" spellcheck="false" style="-webkit-text-security:disc"></textarea>

<label>Adresa jote Binance USDT-TRC20 (DEST) — ku do t'i mbledhësh</label>
<input id="dest" placeholder="T…" autocomplete="off" spellcheck="false">

<label>Çelësi privat i wallet-it të GAZIT (64 hex, me ~50+ TRX) — vetëm për SWEEP</label>
<input id="gasPk" type="password" placeholder="çelësi privat për tarifat (gaz)" autocomplete="off">

<div class="row">
  <div><label>Indekse për të skanuar</label><input id="count" value="60" inputmode="numeric"></div>
  <div><label>Anashkalo nën (USDT)</label><input id="minUsdt" value="5" inputmode="decimal"></div>
  <div><label>TRX gaz / adresë</label><input id="gasTrx" value="35" inputmode="numeric"></div>
</div>
<label>TRONGRID_API_KEY (opsionale — limite më të larta)</label>
<input id="apiKey" placeholder="opsionale" autocomplete="off">

<div class="btns">
  <button class="scan" id="bScan">🔎 Scan balancat</button>
  <button class="dry" id="bDry">🧪 Dry-run (plan)</button>
  <button class="go" id="bGo">🧹 SWEEP — lëviz vërtet</button>
</div>
<div class="total" id="total"></div>
<div class="log" id="log">Gati. Fillo me “Scan balancat”.</div>
</div><script>
const $=id=>document.getElementById(id);
$('toggle').onclick=()=>{const t=$('mnemonic');t.style.webkitTextSecurity=t.style.webkitTextSecurity==='disc'?'none':'disc';};
function body(){return{mnemonic:$('mnemonic').value,dest:$('dest').value,gasPk:$('gasPk').value,count:$('count').value,minUsdt:$('minUsdt').value,gasTrx:$('gasTrx').value,apiKey:$('apiKey').value};}
function setBusy(b){['bScan','bDry','bGo'].forEach(id=>$(id).disabled=b);}
function logln(s){const l=$('log');l.textContent+=(l.textContent?'\\n':'')+s;l.scrollTop=l.scrollHeight;}
async function run(url,extra){
  setBusy(true);$('log').textContent='';$('total').textContent='';
  try{
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body(),...extra})});
    const reader=r.body.getReader();const dec=new TextDecoder();let buf='';
    for(;;){const{value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
      let nl;while((nl=buf.indexOf('\\n'))>=0){const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line)continue;
        const ev=JSON.parse(line);
        if(ev.type==='log')logln(ev.msg);
        else if(ev.type==='error')logln('❌ '+ev.msg);
        else if(ev.type==='scan')$('total').textContent='Total i paprekur: '+ev.total.toFixed(2)+' USDT  ('+ev.funded.length+' adresa)';
        else if(ev.type==='done'&&ev.swept!=null)$('total').textContent='✅ U mblodhën '+ev.swept.toFixed(2)+' USDT';
      }
    }
  }catch(e){logln('❌ '+e);}finally{setBusy(false);}
}
$('bScan').onclick=()=>run('/api/scan',{});
$('bDry').onclick=()=>run('/api/sweep',{execute:false});
$('bGo').onclick=()=>{
  const t=$('dest').value.trim();
  if(!confirm('SWEEP: do të lëvizë GJITHË USDT-në e adresave me fonde → '+t+'.\\n\\nKe bërë Dry-run më parë? Vazhdo vetëm nëse je i sigurt.'))return;
  run('/api/sweep',{execute:true});
};
</script></body></html>`;

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('\n========================================================================');
  console.log('  MURLAN sweep app — LOCAL ONLY (this PC). Seed never leaves the machine.');
  console.log(`  Open:  ${url}`);
  console.log('  Stop:  Ctrl+C when done.');
  console.log('========================================================================\n');
  // Best-effort: open the default browser (Windows/macOS/Linux). Harmless if it fails.
  const cmd = process.platform === 'win32' ? `start "" ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(cmd, () => {});
});
