// ============================================================================
// MURLAN — Telegram admin bot (inbound dispatcher)
// ----------------------------------------------------------------------------
// Turns Telegram button taps + commands into admin actions, reusing the SAME
// audited services as the web admin panel (no parallel money logic). Auth model
// for a solo operator: only the configured owner chat may act — every other
// update is dropped. Each money action runs through WithdrawalService (idempotent,
// ledger-safe) and is written to the admin audit trail under the owner's userId.
//
// Phase 1: interactive withdrawal Approve/Reject (with a confirm tap above a cap)
// + /stats, /withdrawals, /treasury, /help. Phases 2–3 add user/support/balance
// commands by extending the same dispatcher.
// ============================================================================

import { WithdrawalError, type WithdrawalService, type WithdrawalRecord } from '../money/withdrawals.ts';
import type { PayoutProvider } from '../money/payoutProvider.ts';
import type { AdminAuditRepository } from '../auth/adminAudit.ts';
import { HOUSE_ACCOUNT_ID } from '../money/walletService.ts';
import { escapeHtml, type InlineButton } from '../notify/notifier.ts';
import type { TelegramBot } from '../notify/telegramBot.ts';

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// ---- Minimal Telegram update shapes (only the fields we read) ----------------
interface TgChat { id: number | string }
interface TgFrom { id: number | string }
interface TgMessage { message_id: number; chat: TgChat; from?: TgFrom; text?: string }
interface TgCallbackQuery { id: string; from: TgFrom; message?: TgMessage; data?: string }
export interface TgUpdate { update_id?: number; message?: TgMessage; callback_query?: TgCallbackQuery }

/** Narrow read interface so the bot is easy to unit-test without a full wallet. */
export interface BalanceReader { getBalance(accountId: string): Promise<number> }

export interface AdminBotDeps {
  bot: TelegramBot;
  /** TELEGRAM_CHAT_ID — the ONLY chat allowed to issue commands. */
  authorizedChatId: string;
  /** Resolves the owner's admin userId (ADMIN_EMAIL account) so actions are audited
   *  as that admin. Cached by the caller; returns null if no admin account exists. */
  resolveAdminUserId: () => Promise<string | null>;
  withdrawals: WithdrawalService;
  payout: PayoutProvider | null;
  audit: AdminAuditRepository;
  wallet: BalanceReader;
  /** Sum of player balances = house liability. */
  listUsers: () => Promise<Array<{ balanceCents: number }>>;
  /** Withdrawals at/above this need a second confirm tap. 0 = always one-tap. */
  largeWithdrawalCents: number;
  /** Optional: Binance Spot free USDT (cents) for /treasury coverage (null if unknown). */
  binanceFreeUsdtCents?: () => Promise<number | null>;
}

/** Where to edit the message a callback came from. */
interface MessageRef { chatId: number | string; messageId: number | null }

export class TelegramAdminBot {
  constructor(private readonly deps: AdminBotDeps) {}

  private isAuthorized(chatId: number | string | undefined): boolean {
    return chatId !== undefined && String(chatId) === this.deps.authorizedChatId;
  }

  /** Single entry point for a Telegram update. NEVER throws (the webhook always 200s). */
  async handleUpdate(update: TgUpdate): Promise<void> {
    try {
      if (update.callback_query) return await this.handleCallback(update.callback_query);
      if (update.message?.text) return await this.handleMessage(update.message);
    } catch (err) {
      console.error('[telegram-bot] handleUpdate error:', err);
    }
  }

  // ---- Commands ----------------------------------------------------------------
  private async handleMessage(msg: TgMessage): Promise<void> {
    if (!this.isAuthorized(msg.chat.id)) return; // silently ignore strangers
    const cmd = (msg.text!.trim().split(/\s+/)[0] ?? '').replace(/@.*$/, '').toLowerCase();
    switch (cmd) {
      case '/start':
      case '/help':
        return void (await this.deps.bot.sendMessage(this.helpText()));
      case '/stats':
        return void (await this.sendStats());
      case '/withdrawals':
        return void (await this.sendWithdrawals());
      case '/treasury':
        return void (await this.sendTreasury());
      default:
        return void (await this.deps.bot.sendMessage(`Urdhër i panjohur. ${escapeHtml('/help')} për listën.`));
    }
  }

  private helpText(): string {
    return (
      '🤖 <b>Murlan — admin bot</b>\n' +
      'Tërheqjet e reja vijnë me butona [✅ Aprovo] [❌ Refuzo].\n\n' +
      '/withdrawals — radha e tërheqjeve në pritje\n' +
      '/stats — bilanc, detyrime, tërheqje në pritje\n' +
      '/treasury — mbulimi i arkës\n' +
      '/help — kjo listë'
    );
  }

  private async sendStats(): Promise<void> {
    const [house, users, pending] = await Promise.all([
      this.deps.wallet.getBalance(HOUSE_ACCOUNT_ID).catch(() => 0),
      this.deps.listUsers().catch(() => []),
      this.deps.withdrawals.listPending().catch(() => []),
    ]);
    const liabilities = users.reduce((s, u) => s + (u.balanceCents || 0), 0);
    const pendTotal = pending.reduce((s, w) => s + w.amountCents, 0);
    await this.deps.bot.sendMessage(
      '📊 <b>Statistika</b>\n' +
      `Shtëpia (buffer): <b>${usd(house)}</b>\n` +
      `Detyrime lojtarësh: ${usd(liabilities)}\n` +
      `Tërheqje në pritje: <b>${pending.length}</b> (${usd(pendTotal)})`,
    );
  }

  private async sendTreasury(): Promise<void> {
    const [house, users, pending, binanceFree] = await Promise.all([
      this.deps.wallet.getBalance(HOUSE_ACCOUNT_ID).catch(() => 0),
      this.deps.listUsers().catch(() => []),
      this.deps.withdrawals.listPending().catch(() => []),
      this.deps.binanceFreeUsdtCents ? this.deps.binanceFreeUsdtCents().catch(() => null) : Promise.resolve(null),
    ]);
    const liabilities = users.reduce((s, u) => s + (u.balanceCents || 0), 0);
    const pendTotal = pending.reduce((s, w) => s + w.amountCents, 0);
    let lines =
      '🏦 <b>Arka</b>\n' +
      `Shtëpia (buffer): <b>${usd(house)}</b>\n` +
      `Detyrime lojtarësh: ${usd(liabilities)}\n` +
      `Tërheqje në pritje: ${pending.length} (${usd(pendTotal)})`;
    if (binanceFree !== null) {
      const ok = binanceFree >= pendTotal;
      lines +=
        `\nBinance i lirë: <b>${usd(binanceFree)}</b>\n` +
        `Mbulimi i pagesave: ${ok ? '✅ OK' : '⚠️ I PAMJAFTUESHËM'} (lirë ${usd(binanceFree)} vs pritje ${usd(pendTotal)})`;
    } else {
      lines += '\n<i>(Binance jo i konfiguruar — mbulimi i pagesave llogaritet vetëm me të.)</i>';
    }
    await this.deps.bot.sendMessage(lines);
  }

  private async sendWithdrawals(): Promise<void> {
    const pending = await this.deps.withdrawals.listPending().catch(() => []);
    if (!pending.length) {
      await this.deps.bot.sendMessage("✅ S'ka tërheqje në pritje.");
      return;
    }
    const CAP = 20;
    await this.deps.bot.sendMessage(`⏳ <b>${pending.length}</b> tërheqje në pritje${pending.length > CAP ? ` (po shfaq ${CAP})` : ''}:`);
    for (const w of pending.slice(0, CAP)) {
      const r = this.renderPendingRow(w);
      await this.deps.bot.sendMessage(r.text, { buttons: r.buttons });
    }
  }

  /** The standard "pending withdrawal" message + its Approve/Reject buttons. */
  private renderPendingRow(w: WithdrawalRecord): { text: string; buttons: InlineButton[][] } {
    return {
      text:
        `⏳ <b>Tërheqje</b> · ${usd(w.amountCents)}\n` +
        `Adresa: <code>${escapeHtml(w.destination)}</code>`,
      buttons: [[
        { text: '✅ Aprovo', callbackData: `wd:ok:${w.id}` },
        { text: '❌ Refuzo', callbackData: `wd:no:${w.id}` },
      ]],
    };
  }

  // ---- Button taps -------------------------------------------------------------
  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    const ref: MessageRef = { chatId: cq.message?.chat.id ?? this.deps.authorizedChatId, messageId: cq.message?.message_id ?? null };
    // Auth: drop taps from any chat but the owner's (still answer to clear the spinner).
    if (!this.isAuthorized(cq.message?.chat.id ?? cq.from.id)) {
      await this.deps.bot.answerCallbackQuery(cq.id, { text: 'I paautorizuar.' });
      return;
    }
    const parts = (cq.data ?? '').split(':');
    const domain = parts[0];
    const action = parts[1];
    const id = parts.slice(2).join(':');
    if (domain !== 'wd' || !id) {
      await this.deps.bot.answerCallbackQuery(cq.id);
      return;
    }
    switch (action) {
      case 'ok': // approve (may step up to a confirm for large amounts)
        await this.onApproveTap(id, ref, cq.id);
        break;
      case 'cfm': // confirmed approve (second tap)
        await this.deps.bot.answerCallbackQuery(cq.id, { text: 'Po e dërgoj…' });
        await this.doApprove(id, ref);
        break;
      case 'x': // cancel a pending confirm → restore the row
        await this.onCancelConfirm(id, ref, cq.id);
        break;
      case 'no': // reject
        await this.deps.bot.answerCallbackQuery(cq.id, { text: 'Po e refuzoj…' });
        await this.doReject(id, ref);
        break;
      default:
        await this.deps.bot.answerCallbackQuery(cq.id);
    }
  }

  private async onApproveTap(id: string, ref: MessageRef, callbackId: string): Promise<void> {
    const w = await this.deps.withdrawals.find(id).catch(() => null);
    if (!w) {
      await this.deps.bot.answerCallbackQuery(callbackId, { text: 'Nuk u gjet.', showAlert: true });
      await this.editResolved(ref, '⚠️ Tërheqja nuk u gjet.');
      return;
    }
    if (w.status !== 'pending') {
      await this.deps.bot.answerCallbackQuery(callbackId, { text: `Tashmë: ${w.status}.`, showAlert: true });
      await this.editResolved(ref, `⚠️ Nuk është më në pritje (gjendja: ${escapeHtml(w.status)}).`);
      return;
    }
    // Large withdrawals require a second confirm tap (amount echoed back).
    if (this.deps.largeWithdrawalCents > 0 && w.amountCents >= this.deps.largeWithdrawalCents) {
      await this.deps.bot.answerCallbackQuery(callbackId);
      await this.editMessage(ref,
        `⚠️ <b>Konfirmo tërheqjen e madhe</b>\n` +
        `Shuma: <b>${usd(w.amountCents)}</b>\n` +
        `Adresa: <code>${escapeHtml(w.destination)}</code>\n` +
        `Shtyp <b>Konfirmo</b> për ta dërguar.`,
        [[
          { text: `✅ Konfirmo ${usd(w.amountCents)}`, callbackData: `wd:cfm:${id}` },
          { text: '✖️ Anulo', callbackData: `wd:x:${id}` },
        ]],
      );
      return;
    }
    await this.deps.bot.answerCallbackQuery(callbackId, { text: 'Po e dërgoj…' });
    await this.doApprove(id, ref);
  }

  private async onCancelConfirm(id: string, ref: MessageRef, callbackId: string): Promise<void> {
    await this.deps.bot.answerCallbackQuery(callbackId, { text: 'Anuluar.' });
    const w = await this.deps.withdrawals.find(id).catch(() => null);
    if (w && w.status === 'pending') {
      const r = this.renderPendingRow(w);
      await this.editMessage(ref, r.text, r.buttons);
    } else {
      await this.editResolved(ref, w ? `⚠️ Nuk është më në pritje (gjendja: ${escapeHtml(w.status)}).` : '⚠️ Tërheqja nuk u gjet.');
    }
  }

  private async doApprove(id: string, ref: MessageRef): Promise<void> {
    const adminId = await this.deps.resolveAdminUserId();
    if (!adminId) {
      await this.editResolved(ref, '⚠️ S’u gjet llogaria admin (ADMIN_EMAIL) — aprovimi u ndal.');
      return;
    }
    try {
      // SAME path as the admin panel: payoutNow sends on-chain (or marks paid when no
      // provider), atomically claims the row, and refunds on send failure. Idempotent.
      const w = await this.deps.withdrawals.payoutNow(id, this.deps.payout, { resolvedByAdminId: adminId });
      await this.deps.audit.record({
        adminId, action: 'withdrawal_approve', targetUserId: w.userId, amountCents: w.amountCents,
        detail: w.providerRef ? `${id} (telegram, sent: ${w.providerRef})` : `${id} (telegram)`,
      });
      await this.editResolved(ref, `✅ <b>Aprovuar</b> · ${usd(w.amountCents)}${w.providerRef ? ` · ref <code>${escapeHtml(w.providerRef)}</code>` : ''}`);
    } catch (e) {
      const msg = e instanceof WithdrawalError ? e.message : 'Gabim i papritur gjatë aprovimit.';
      await this.editResolved(ref, `⚠️ ${escapeHtml(msg)}`);
    }
  }

  private async doReject(id: string, ref: MessageRef): Promise<void> {
    const adminId = await this.deps.resolveAdminUserId();
    if (!adminId) {
      await this.editResolved(ref, '⚠️ S’u gjet llogaria admin (ADMIN_EMAIL) — refuzimi u ndal.');
      return;
    }
    try {
      const w = await this.deps.withdrawals.reject(id, { resolvedByAdminId: adminId, failureReason: 'Refuzuar nga admini (Telegram)' });
      await this.deps.audit.record({
        adminId, action: 'withdrawal_reject', targetUserId: w.userId, amountCents: w.amountCents, detail: `${id} (telegram)`,
      });
      await this.editResolved(ref, `❌ <b>Refuzuar</b> · ${usd(w.amountCents)} · fondet u kthyen lojtarit.`);
    } catch (e) {
      const msg = e instanceof WithdrawalError ? e.message : 'Gabim i papritur gjatë refuzimit.';
      await this.editResolved(ref, `⚠️ ${escapeHtml(msg)}`);
    }
  }

  // ---- Message edit helpers ----------------------------------------------------
  /** Replace the message text + keyboard (falls back to a fresh message if we have
   *  no message id to edit). */
  private async editMessage(ref: MessageRef, text: string, buttons: InlineButton[][]): Promise<void> {
    if (ref.messageId !== null) await this.deps.bot.editMessageText(ref.chatId, ref.messageId, text, { buttons });
    else await this.deps.bot.sendMessage(text, { buttons });
  }

  /** Edit to a final state with the buttons cleared. */
  private async editResolved(ref: MessageRef, text: string): Promise<void> {
    if (ref.messageId !== null) await this.deps.bot.editMessageText(ref.chatId, ref.messageId, text, { buttons: [] });
    else await this.deps.bot.sendMessage(text);
  }
}
