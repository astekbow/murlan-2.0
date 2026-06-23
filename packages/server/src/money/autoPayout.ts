// ============================================================================
// MURLAN — Withdrawal post-processing (semi-auto payout + ops alert)
// ----------------------------------------------------------------------------
// Runs right after a withdrawal is requested (off the response path). Decides the
// handling tier (withdrawalPolicy), optionally AUTO-PAYS small withdrawals via a payout
// provider, then pings the operator on Telegram. The crypto for everything else stays
// manual. Money safety (money-16):
//   • Auto-pay fires ONLY for tier 'auto' AND when a real payout provider is configured.
//   • The actual send goes through WithdrawalService.autoPayout, which CLAIMS the row
//     (pending→completed) BEFORE sending — so a concurrent reject/approve in the send
//     window can NOT double-pay — and refunds ONLY on a DEFINITE failure. A DUPLICATE
//     (provider idempotency hit) or AMBIGUOUS (timeout/5xx) result is left PAID, never
//     refunded. The send is single-shot (no retry loop); the reconciler handles a stuck send.
//   • An auto-paid row needs NO operator action → no Approve/Reject buttons. "Approve" in
//     the panel/Telegram is therefore always a CLAIM-then-send on a STILL-PENDING row, and
//     can never re-send / double-pay an already-auto-sent one (payoutNow refuses not-pending).
// ============================================================================

import { classifyWithdrawal, type WithdrawalTier } from './withdrawalPolicy.ts';
import { type Notifier, escapeHtml } from '../notify/notifier.ts';

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface WithdrawalForProcessing {
  id: string;
  amountCents: number;
  destination: string;
}

/** Outcome of the claim-first auto-send (WithdrawalService.autoPayout). */
export type AutoSendOutcome = { outcome: 'paid' | 'duplicate' | 'ambiguous' | 'failed' | 'not_pending' | 'bad_destination'; providerRef?: string | null; error?: string };

export interface ProcessDeps {
  /** CLAIM-FIRST auto-send (WithdrawalService.autoPayout). Present only when a real payout
   *  provider is configured. It claims the row pending→completed BEFORE sending, so it is
   *  the SOLE money-moving step here — there is no separate "approve" that could re-send. */
  sendAuto: ((id: string) => Promise<AutoSendOutcome>) | null;
  notifier: Notifier | null;
  autoMaxCents: number;
  dailyAutoCapCents?: number; // 0/undefined = no per-user daily cap
  globalAutoCapCents?: number; // money-7: 0/undefined = off; global 24h auto-payout budget
  destAutoCapCents?: number; // money-7: 0/undefined = off; per-destination 24h auto-payout cap
}

export interface ProcessOutcome {
  tier: WithdrawalTier;
  autoPaid: boolean;
  /** True when the send result was AMBIGUOUS (maybe-sent) — left paid, flagged for ops, NEVER refunded. */
  ambiguous: boolean;
  error: string | null;
}

export async function processWithdrawal(
  record: WithdrawalForProcessing,
  ctx: { username: string; kycStatus: string | null | undefined; priorTodayCents?: number; globalTodayCents?: number; destTodayCents?: number; recentTransferInCents?: number },
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  const cls = classifyWithdrawal(
    { amountCents: record.amountCents, kycStatus: ctx.kycStatus, priorTodayCents: ctx.priorTodayCents, globalTodayCents: ctx.globalTodayCents, destTodayCents: ctx.destTodayCents, recentTransferInCents: ctx.recentTransferInCents },
    { autoMaxCents: deps.autoMaxCents, dailyAutoCapCents: deps.dailyAutoCapCents, globalAutoCapCents: deps.globalAutoCapCents, destAutoCapCents: deps.destAutoCapCents },
  );
  const canAutoSend = !!deps.sendAuto;

  let autoPaid = false;
  let ambiguous = false;
  let error: string | null = null;

  if (cls.tier === 'auto' && deps.sendAuto) {
    // The send is claim-first + refund-safe inside autoPayout(); it NEVER throws here.
    const r = await deps.sendAuto(record.id).catch((e): AutoSendOutcome => ({ outcome: 'ambiguous', error: `auto-send threw: ${String(e)}` }));
    if (r.outcome === 'paid' || r.outcome === 'duplicate') {
      autoPaid = true; // 'duplicate' = the earlier send stands → still "paid" (no refund)
      if (r.outcome === 'duplicate') error = `duplicate send (already paid): ${r.error ?? ''}`;
    } else if (r.outcome === 'ambiguous') {
      ambiguous = true;
      error = `ambiguous (maybe sent, NOT refunded): ${r.error ?? ''}`;
    } else if (r.outcome === 'not_pending') {
      error = 'no longer pending at send time (already resolved) — not sent';
    } else {
      error = r.error ?? 'payout failed';
    }
  }

  if (deps.notifier) {
    const head =
      autoPaid ? '✅ <b>Tërheqje — u pagua AUTO</b>'
      : ambiguous ? '🚨 <b>Auto-payout I PASIGURT — VERIFIKO on-chain</b>'
      : cls.tier === 'auto' && canAutoSend ? '⚠️ <b>Auto-payout DËSHTOI — paguaj manualisht</b>'
      : cls.tier === 'auto' ? '✅ <b>Tërheqje — e sigurt (fast-track)</b>'
      : '⚠️ <b>Tërheqje — rishiko</b>';
    const tail =
      autoPaid ? (error ? `→ U dërgua automatikisht. ${escapeHtml(error)}` : '→ U dërgua automatikisht (USDT-TRC20). Asgjë për të bërë.')
      : ambiguous ? `→ Dërgimi automatik mbeti i PASIGURT (${escapeHtml(error ?? '')}). Fondet NUK u rikthyen — verifiko on-chain para çdo veprimi.`
      : cls.tier === 'auto' && canAutoSend ? `→ Dështoi auto: ${escapeHtml(error ?? '')}. Fondet u rikthyen — Aprovo për ta dërguar përsëri.`
      : cls.tier === 'auto' ? '→ E vogël: e sigurt për ta aprovuar shpejt (Aprovo e dërgon vetë on-chain).'
      : `→ Rishiko para aprovimit: ${cls.reasons.join(', ')}.`;
    const text =
      `${head}\n` +
      `Lojtari: ${escapeHtml(ctx.username)}\n` +
      `Shuma: <b>${usd(record.amountCents)}</b>\n` +
      `Adresa: <code>${escapeHtml(record.destination)}</code>\n` +
      `KYC: ${ctx.kycStatus ?? '?'}\n` +
      tail;
    // Show [✅ Approve] [❌ Reject] ONLY on a STILL-PENDING row (manual review, or auto-pay
    // didn't fire / DEFINITELY failed-and-refunded → back to pending). An auto-PAID or
    // AMBIGUOUS row is NOT pending, so it gets NO action buttons — "Approve" can therefore
    // never be a re-send of an already-sent payout (panel/bot also refuse a not-pending row).
    const stillPending = !autoPaid && !ambiguous;
    if (stillPending && deps.notifier.notifyInteractive) {
      await deps.notifier.notifyInteractive(text, [
        [
          { text: '✅ Aprovo', callbackData: `wd:ok:${record.id}` },
          { text: '❌ Refuzo', callbackData: `wd:no:${record.id}` },
        ],
        [{ text: '👤 Rreziku', callbackData: `wd:risk:${record.id}` }],
      ]);
    } else {
      await deps.notifier.notify(text);
    }
  }

  return { tier: cls.tier, autoPaid, ambiguous, error };
}
