// ============================================================================
// MURLAN — Binance deposit watcher (unclaimed-deposit safety net)
// ----------------------------------------------------------------------------
// Deposits are credited when the PLAYER submits the TxID (we verify on-chain).
// This watcher is the safety net for the one gap: a player who deposits but
// FORGETS to submit the TxID. It polls Binance deposit history and, for any USDT
// (TRC20) deposit that arrived but was never claimed (no ledger row for its
// providerRef), pings the operator on Telegram so they can credit it manually.
// It does NOT auto-credit (it can't know which player) — it just surfaces the gap.
// ============================================================================

import { createHmac } from 'node:crypto';

const API_PROD = 'https://api.binance.com';

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface BinanceDeposit {
  txId: string;
  amountCents: number;
  address: string;
  insertTime: number; // epoch ms
}

export interface BinanceDepositListerOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  now?: () => number;
}

/** Lists recent SUCCESSFUL USDT-TRC20 deposits to your Binance account (signed). */
export class BinanceDepositLister {
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: BinanceDepositListerOptions) {
    this.base = opts.baseUrl ?? API_PROD;
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? (() => Date.now());
  }

  async listRecent(sinceMs: number): Promise<BinanceDeposit[]> {
    const params = new URLSearchParams({
      coin: 'USDT',
      status: '1', // 1 = success (credited)
      startTime: String(Math.max(0, Math.floor(sinceMs))),
      timestamp: String(this.now()),
      recvWindow: '10000',
    });
    const signature = createHmac('sha256', this.opts.apiSecret).update(params.toString()).digest('hex');
    params.append('signature', signature);
    const res = await this.fetchFn(`${this.base}/sapi/v1/capital/deposit/hisrec?${params.toString()}`, { headers: { 'X-MBX-APIKEY': this.opts.apiKey } });
    if (!res.ok) throw new Error(`binance deposit history failed (${res.status})`);
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => String(r.network) === 'TRX') // TRC20 only (the TxID flow is TRON)
      .map((r) => ({ txId: String(r.txId ?? ''), amountCents: Math.round(Number(r.amount) * 100), address: String(r.address ?? ''), insertTime: Number(r.insertTime ?? 0) }))
      .filter((d) => d.txId.length > 0 && Number.isFinite(d.amountCents));
  }
}

export interface UnclaimedCheckDeps {
  list: (sinceMs: number) => Promise<BinanceDeposit[]>;
  isClaimed: (txIdLower: string) => Promise<boolean>; // already credited via the TxID flow?
  notify: (text: string) => Promise<void>;
  alerted: Set<string>; // txIds already alerted (don't re-ping)
  now: number;          // epoch ms (passed in for testability)
  graceMs?: number;     // ignore deposits younger than this (the player may still submit) — default 10m
  windowMs?: number;    // only look this far back — default 24h
}

/**
 * Alert the operator about USDT-TRC20 deposits that arrived at Binance but were
 * never claimed via the TxID flow. Returns how many fresh alerts were sent.
 */
export async function checkUnclaimedDeposits(deps: UnclaimedCheckDeps): Promise<number> {
  const windowMs = deps.windowMs ?? 24 * 60 * 60 * 1000;
  const graceMs = deps.graceMs ?? 10 * 60 * 1000;
  const deposits = await deps.list(deps.now - windowMs);
  let alerts = 0;
  for (const d of deposits) {
    const id = d.txId.toLowerCase();
    if (deps.alerted.has(id)) continue;            // already pinged
    if (deps.now - d.insertTime < graceMs) continue; // give the player time to submit it
    if (await deps.isClaimed(id)) continue;        // already credited in-app
    deps.alerted.add(id);
    await deps.notify(
      `⚠️ <b>Depozitë e PA-ATRIBUUAR</b>\n` +
      `Shuma: <b>$${(d.amountCents / 100).toFixed(2)}</b>\n` +
      `TxID: <code>${d.txId}</code>\n` +
      `→ Arriti te Binance por lojtari s'e kërkoi. Gjeje + kredito nga admin paneli.`,
    );
    alerts++;
  }
  return alerts;
}
