// ============================================================================
// MURLAN — TRON (USDT-TRC20) deposit verification via TronGrid
// ----------------------------------------------------------------------------
// Fee-free deposits without a processor: the player sends USDT-TRC20 to YOUR
// address, then submits the transaction id (TxID). We verify it on-chain via the
// FREE TronGrid API — was it a USDT transfer TO our address, and how much — then
// credit the player (idempotent on the TxID, so a tx credits at most once).
//
// We query TronGrid's "TRC20 transfers to this account" endpoint (addresses come
// back in base58 `T...`, so no hex decoding) and match by transaction_id. Limit
// 200 = the deposit must be claimed before 200 newer incoming transfers bury it
// (fine for low volume; raise/paginate later if needed).
// ============================================================================

import { tronAddressToAbiParam } from './tronAddress.ts';

// Mainnet USDT-TRC20 contract.
export const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const API = 'https://api.trongrid.io';

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface TronDepositVerification {
  ok: boolean;
  amountCents?: number;
  from?: string;
  error?: string;
}

export interface TronDepositOptions {
  depositAddress?: string; // DEFAULT receiving address (legacy single-address mode);
                           // with per-player addresses, verify() is given the address.
  apiKey?: string | null;  // TronGrid API key (free); higher rate limits when set
  contract?: string;       // token contract (defaults to mainnet USDT)
  baseUrl?: string;
  fetchFn?: FetchLike;
}

export class TronDepositVerifier {
  private readonly contract: string;
  private readonly base: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly opts: TronDepositOptions) {
    this.contract = opts.contract ?? USDT_TRC20_CONTRACT;
    this.base = opts.baseUrl ?? API;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  }

  /**
   * Verify a TxID is a real USDT-TRC20 transfer TO `toAddress` (the player's OWN
   * unique deposit address — pass it explicitly; falls back to the configured
   * single address). Binding the credit to the recipient address is what makes
   * claim-jacking impossible: a stranger's TxID went to THEIR address, not yours,
   * so it isn't in your address's transfer list and `tx.to` won't match.
   */
  async verify(txId: string, toAddress?: string): Promise<TronDepositVerification> {
    if (!/^[0-9a-fA-F]{64}$/.test(txId)) return { ok: false, error: 'TxID i pavlefshëm.' };
    const dest = toAddress ?? this.opts.depositAddress;
    if (!dest) return { ok: false, error: 'Mungon adresa e marrjes.' };
    const want = txId.toLowerCase();
    try {
      const url = `${this.base}/v1/accounts/${dest}/transactions/trc20?only_to=true&contract_address=${this.contract}&limit=200`;
      const res = await this.fetchFn(url, this.opts.apiKey ? { headers: { 'TRON-PRO-API-KEY': this.opts.apiKey } } : {});
      if (!res.ok) return { ok: false, error: `TronGrid ${res.status}` };
      const data = await res.json();
      // Compare case-insensitively (TRON hashes are lowercase hex, but don't assume).
      const tx = (data?.data ?? []).find((t: any) => String(t.transaction_id).toLowerCase() === want);
      if (!tx) return { ok: false, error: 'Transaksioni nuk u gjet ose nuk shkoi te adresa e duhur.' };
      if (tx.to !== dest) return { ok: false, error: 'Marrësi i gabuar.' };
      // REQUIRE the exact USDT contract — a missing/empty token_info.address (a fake
      // or scam token) must be REJECTED, not skipped. (undefined !== contract ⇒ reject.)
      if (tx.token_info?.address !== this.contract) return { ok: false, error: 'Nuk është USDT-TRC20.' };
      const value = Number(tx.value);
      if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'Shumë e pavlefshme.' };
      // Validate decimals (a hostile/garbage value could inflate the credit). USDT=6.
      const decimals = tx.token_info?.decimals == null ? 6 : Number(tx.token_info.decimals);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return { ok: false, error: 'Token i pavlefshëm.' };
      // Integer math (multiply before divide) to avoid float-precision inflation.
      const amountCents = Math.floor((value * 100) / 10 ** decimals);
      if (amountCents <= 0) return { ok: false, error: 'Shumë shumë e vogël.' };
      return { ok: true, amountCents, from: tx.from };
    } catch (err) {
      return { ok: false, error: `Gabim verifikimi: ${String(err)}` };
    }
  }

  /**
   * Current USDT-TRC20 balance of an address, in USD cents — for the admin treasury
   * view (how much sits in deposit addresses awaiting a sweep). Reads the contract's
   * balanceOf via a constant call: this is RELIABLE even for addresses that hold USDT
   * but no TRX (the /v1/accounts endpoint returns EMPTY for those — they're "inactive"
   * on-chain — which would wrongly read as 0). Returns null on any error.
   */
  async usdtBalanceCents(address: string): Promise<number | null> {
    try {
      const param = tronAddressToAbiParam(address);
      if (!param) return null;
      const res = await this.fetchFn(`${this.base}/wallet/triggerconstantcontract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { 'TRON-PRO-API-KEY': this.opts.apiKey } : {}) },
        body: JSON.stringify({
          owner_address: address,
          contract_address: this.contract,
          function_selector: 'balanceOf(address)',
          parameter: param,
          visible: true,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const hex = data?.constant_result?.[0];
      if (hex == null || typeof hex !== 'string') return null;
      return Number(BigInt('0x' + hex) / 10_000n); // 6-decimal USDT raw → integer USD cents
    } catch {
      return null;
    }
  }
}
