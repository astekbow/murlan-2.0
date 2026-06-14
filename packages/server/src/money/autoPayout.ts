// ============================================================================
// MURLAN — Withdrawal post-processing (semi-auto payout + ops alert)
// ----------------------------------------------------------------------------
// Runs right after a withdrawal is requested (off the response path). Decides the
// handling tier (withdrawalPolicy), optionally AUTO-PAYS small KYC-verified
// withdrawals via a payout provider, then pings the operator on Telegram. The
// crypto for everything else stays manual. Money safety:
//   • Auto-pay fires ONLY for tier 'auto' (≤ threshold AND KYC verified) AND when
//     a real payout provider is configured — else nothing is sent.
//   • The provider call is one-shot per withdrawal request (no retry loop), so a
//     success-then-mark-failed leaves the row PENDING (operator finishes it with
//     one click — approve never re-sends). No automatic double-send is possible.
// ============================================================================

import { classifyWithdrawal, type WithdrawalTier } from './withdrawalPolicy.ts';
import type { PayoutProvider } from './payoutProvider.ts';
import { type Notifier, escapeHtml } from '../notify/notifier.ts';

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface WithdrawalForProcessing {
  id: string;
  amountCents: number;
  destination: string;
}

export interface ProcessDeps {
  /** Mark a withdrawal completed (idempotent) once the external send succeeded.
   *  `audit` records the payout provider ref/network for the audit trail. */
  approve: (id: string, audit?: { providerRef?: string | null; network?: string | null }) => Promise<unknown>;
  payout: PayoutProvider | null; // null / NullPayoutProvider → no auto-send
  notifier: Notifier | null;
  autoMaxCents: number;
  dailyAutoCapCents?: number; // 0/undefined = no daily cap
}

export interface ProcessOutcome {
  tier: WithdrawalTier;
  autoPaid: boolean;
  error: string | null;
}

export async function processWithdrawal(
  record: WithdrawalForProcessing,
  ctx: { username: string; kycStatus: string | null | undefined; priorTodayCents?: number },
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  const cls = classifyWithdrawal(
    { amountCents: record.amountCents, kycStatus: ctx.kycStatus, priorTodayCents: ctx.priorTodayCents },
    { autoMaxCents: deps.autoMaxCents, dailyAutoCapCents: deps.dailyAutoCapCents },
  );
  const provider = deps.payout && deps.payout.name !== 'null' ? deps.payout : null;

  let autoPaid = false;
  let error: string | null = null;

  if (cls.tier === 'auto' && provider) {
    const r = await provider
      .payout({ withdrawalId: record.id, amountCents: record.amountCents, address: record.destination })
      .catch((e): { ok: false; error: string } => ({ ok: false, error: `payout threw: ${String(e)}` }));
    if (r.ok) {
      autoPaid = true;
      // The send succeeded → mark completed. Retry a few times (a transient DB blip
      // shouldn't strand a paid withdrawal as pending); approve() is idempotent.
      let marked = false;
      for (let attempt = 1; attempt <= 3 && !marked; attempt++) {
        try { await deps.approve(record.id, { providerRef: r.providerRef ?? null }); marked = true; }
        catch (e) { if (attempt === 3) error = `paid but mark-complete failed after retries: ${String(e)}`; }
      }
    } else {
      error = r.error ?? 'payout failed';
    }
  }

  if (deps.notifier) {
    const head =
      autoPaid ? '✅ <b>Tërheqje — u pagua AUTO</b>'
      : cls.tier === 'auto' && provider ? '⚠️ <b>Auto-payout DËSHTOI — paguaj manualisht</b>'
      : cls.tier === 'auto' ? '✅ <b>Tërheqje — e sigurt (fast-track)</b>'
      : '⚠️ <b>Tërheqje — rishiko</b>';
    const tail =
      autoPaid ? (error ? `→ U dërgua, por shënoje "Approve" te paneli (${escapeHtml(error)}).` : '→ U dërgua automatikisht (USDT-TRC20). Asgjë për të bërë.')
      : cls.tier === 'auto' && provider ? `→ Dështoi auto: ${escapeHtml(error ?? '')}. Paguaj + Aprovo manualisht.`
      : cls.tier === 'auto' ? '→ E vogël + KYC e verifikuar: e sigurt për ta aprovuar shpejt (pasi ta dërgosh).'
      : `→ Rishiko para aprovimit: ${cls.reasons.join(', ')}.`;
    await deps.notifier.notify(
      `${head}\n` +
      `Lojtari: ${escapeHtml(ctx.username)}\n` +
      `Shuma: <b>${usd(record.amountCents)}</b>\n` +
      `Adresa: <code>${escapeHtml(record.destination)}</code>\n` +
      `KYC: ${ctx.kycStatus ?? '?'}\n` +
      tail,
    );
  }

  return { tier: cls.tier, autoPaid, error };
}
