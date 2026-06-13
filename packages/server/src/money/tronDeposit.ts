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

// Mainnet USDT-TRC20 contract.
export const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const API = 'https://api.trongrid.io';

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface TronDepositVerification {
  ok: boolean;
  amountCents?: number;
  from?: string;
  error?: string;
}

export interface TronDepositOptions {
  depositAddress: string;  // YOUR USDT-TRC20 receiving address (base58 T...)
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

  async verify(txId: string): Promise<TronDepositVerification> {
    if (!/^[0-9a-fA-F]{64}$/.test(txId)) return { ok: false, error: 'TxID i pavlefshëm.' };
    try {
      const url = `${this.base}/v1/accounts/${this.opts.depositAddress}/transactions/trc20?only_to=true&contract_address=${this.contract}&limit=200`;
      const res = await this.fetchFn(url, this.opts.apiKey ? { headers: { 'TRON-PRO-API-KEY': this.opts.apiKey } } : {});
      if (!res.ok) return { ok: false, error: `TronGrid ${res.status}` };
      const data = await res.json();
      const tx = (data?.data ?? []).find((t: any) => t.transaction_id === txId);
      if (!tx) return { ok: false, error: 'Transaksioni nuk u gjet ose nuk shkoi te adresa e duhur.' };
      if (tx.to !== this.opts.depositAddress) return { ok: false, error: 'Marrësi i gabuar.' };
      if (tx.token_info?.address && tx.token_info.address !== this.contract) return { ok: false, error: 'Nuk është USDT-TRC20.' };
      const value = Number(tx.value);
      const decimals = Number(tx.token_info?.decimals ?? 6);
      if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'Shumë e pavlefshme.' };
      const amountCents = Math.round((value / 10 ** decimals) * 100);
      if (amountCents <= 0) return { ok: false, error: 'Shumë shumë e vogël.' };
      return { ok: true, amountCents, from: tx.from };
    } catch (err) {
      return { ok: false, error: `Gabim verifikimi: ${String(err)}` };
    }
  }
}
