import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { InMemoryLedger } from '../money/ledger.ts';
import { WalletService } from '../money/walletService.ts';
import { InMemoryWithdrawals, WithdrawalService } from '../money/withdrawals.ts';
import { MockPaymentProvider } from '../money/paymentProvider.ts';
import { InMemoryDepositIntents } from '../money/depositIntents.ts';
import { TronHdWallet } from '../money/tronHd.ts';
import { TronDepositVerifier, USDT_TRC20_CONTRACT } from '../money/tronDeposit.ts';

const XPUB = 'xpub6EuK4CZWW5urEHdwAVDdDw327danAtccFcrXYvgf1DHrPXRwErt36xStQ2PNhn4hpwzPbzJ8pJVpewgChRnSs59q5Ay61GCfQZKUe71gbLq';
const TXID = 'a'.repeat(64); // a valid-shaped TRON tx hash (64 hex)
const authH = (t: string) => ({ authorization: `Bearer ${t}` });

// A stubbed TronGrid: returns the on-chain deposit ONLY for the address it was
// actually sent to (`landedAt`). This mirrors reality — a transfer appears in the
// recipient address's transfer list, nowhere else.
function stubVerifier(landedAt: string, valueRaw = '50000000' /* 50 USDT, 6 decimals */) {
  const fetchFn = async (url: string) => {
    const addr = url.match(/\/accounts\/([^/]+)\/transactions/)?.[1] ?? '';
    const data = addr === landedAt
      ? [{ transaction_id: TXID, to: landedAt, from: 'TDonorWalletXXXXXXXXXXXXXXXXXXXXXXX', value: valueRaw, token_info: { address: USDT_TRC20_CONTRACT, decimals: 6 } }]
      : [];
    return { ok: true, status: 200, async json() { return { data }; } };
  };
  return new TronDepositVerifier({ apiKey: null, fetchFn: fetchFn as any });
}

async function build(landedAtIndex = 0) {
  const repo = new InMemoryUserRepository();
  const ledger = new InMemoryLedger();
  const wallet = new WalletService(repo, ledger);
  const withdrawals = new WithdrawalService(wallet, new InMemoryWithdrawals());
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens);
  const depositWallet = new TronHdWallet(XPUB);
  const tronDeposit = stubVerifier(depositWallet.addressAt(landedAtIndex));
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const app = await buildHttpApp({
    auth, config, wallet, withdrawals, provider: new MockPaymentProvider('whsec'),
    intents: new InMemoryDepositIntents(), tronDeposit, depositWallet,
  });
  const a = await auth.register({ username: 'alice', email: 'a@x.com', password: 'password123' });
  const b = await auth.register({ username: 'bob', email: 'b@x.com', password: 'password123' });
  return { app, wallet, depositWallet, tokenA: a.tokens.accessToken, tokenB: b.tokens.accessToken, idA: a.user.id, idB: b.user.id };
}

test('each player gets a UNIQUE deposit address, assigned deterministically + idempotently', async () => {
  const { app, depositWallet, tokenA, tokenB } = await build();
  const addrA = (await app.inject({ method: 'GET', url: '/api/wallet/deposit/address', headers: authH(tokenA) })).json().address;
  const addrB = (await app.inject({ method: 'GET', url: '/api/wallet/deposit/address', headers: authH(tokenB) })).json().address;
  assert.equal(addrA, depositWallet.addressAt(0)); // first to ask → index 0
  assert.equal(addrB, depositWallet.addressAt(1)); // second → index 1
  assert.notEqual(addrA, addrB);
  // Idempotent: asking again returns the same address.
  const again = (await app.inject({ method: 'GET', url: '/api/wallet/deposit/address', headers: authH(tokenA) })).json().address;
  assert.equal(again, addrA);
  await app.close();
});

test('CLAIM-JACK BLOCKED: a player cannot claim a TxID that landed in ANOTHER player’s address', async () => {
  // The deposit lands in Alice's address (index 0). Bob tries to steal it.
  const { app, wallet, tokenA, tokenB, idA, idB } = await build(0);
  // assign both addresses first (so indices are 0=alice, 1=bob)
  await app.inject({ method: 'GET', url: '/api/wallet/deposit/address', headers: authH(tokenA) });
  await app.inject({ method: 'GET', url: '/api/wallet/deposit/address', headers: authH(tokenB) });

  // Bob submits Alice's TxID → verified against BOB's address → not found → rejected.
  const stolen = await app.inject({ method: 'POST', url: '/api/wallet/deposit/txid', headers: authH(tokenB), payload: { txId: TXID } });
  assert.equal(stolen.statusCode, 400);
  assert.equal(stolen.json().error.code, 'not_verified');
  assert.equal(await wallet.getBalance(idB), 0); // Bob got nothing

  // Alice submits her own TxID → verified against HER address → credited.
  const ok = await app.inject({ method: 'POST', url: '/api/wallet/deposit/txid', headers: authH(tokenA), payload: { txId: TXID } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().amountCents, 5000); // 50 USDT
  assert.equal(await wallet.getBalance(idA), 5000);
  await app.close();
});

test('a TxID credits at most once (idempotent) even for the rightful owner', async () => {
  const { app, wallet, tokenA, idA } = await build(0);
  await app.inject({ method: 'GET', url: '/api/wallet/deposit/address', headers: authH(tokenA) });
  const first = await app.inject({ method: 'POST', url: '/api/wallet/deposit/txid', headers: authH(tokenA), payload: { txId: TXID } });
  assert.equal(first.statusCode, 201);
  const replay = await app.inject({ method: 'POST', url: '/api/wallet/deposit/txid', headers: authH(tokenA), payload: { txId: TXID } });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error.code, 'already_used');
  assert.equal(await wallet.getBalance(idA), 5000); // not double-credited
  await app.close();
});
