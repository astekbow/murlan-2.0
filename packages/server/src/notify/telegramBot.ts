// ============================================================================
// MURLAN — Telegram Bot API client (outbound side of the admin bot)
// ----------------------------------------------------------------------------
// The richer counterpart of TelegramNotifier: besides plain alerts it can send
// inline-keyboard buttons, edit a message in place (so a resolved withdrawal's
// buttons turn into "✅ Approved by you"), answer a button tap, and register the
// inbound webhook. It IS a Notifier (drop-in for `notifier`) and additionally
// exposes `notifyInteractive`, used so the new-withdrawal alert carries
// Approve/Reject buttons. Like the notifier, sends are best-effort + NEVER throw
// into a money flow — a Telegram hiccup must not break the app.
// ============================================================================

import { log } from '../logger.ts';
import { type Notifier, type InlineButton, escapeHtml } from './notifier.ts';

export { escapeHtml };

type FetchResult = { ok: boolean; status: number; json: () => Promise<unknown> };
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResult>;

/** Telegram's `{ ok, result, description }` envelope (the bits we read). */
interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: { message_id?: number } | boolean | unknown;
}

function toInlineKeyboard(buttons: InlineButton[][]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))) };
}

export class TelegramBot implements Notifier {
  readonly name = 'telegram-bot';
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  /** Low-level Bot API call with a short retry on 5xx/429. Returns the parsed
   *  envelope, or null if it ultimately failed (caller treats null as best-effort
   *  failure — never throws). */
  private async call(method: string, body: Record<string, unknown>): Promise<TelegramResponse | null> {
    const ATTEMPTS = 3;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          return (await res.json().catch(() => ({ ok: true }))) as TelegramResponse;
        }
        // 4xx (bad token/chat/markup) won't fix on retry — log + stop; 5xx/429 may retry.
        if (res.status < 500 && res.status !== 429) {
          log.error(`[telegram] ${method} failed: HTTP ${res.status} (not retryable)`);
          return null;
        }
        log.error(`[telegram] ${method} HTTP ${res.status} (attempt ${attempt}/${ATTEMPTS})`);
      } catch (err) {
        log.error(`[telegram] ${method} error (attempt ${attempt}/${ATTEMPTS}):`, err);
      }
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    return null;
  }

  /** Plain alert (Notifier interface) — to the configured owner chat. */
  async notify(text: string): Promise<void> {
    await this.sendMessage(text);
  }

  /** Alert WITH inline buttons (Notifier optional method). */
  async notifyInteractive(text: string, buttons: InlineButton[][]): Promise<void> {
    await this.sendMessage(text, { buttons });
  }

  /** Send a message to a chat (defaults to the owner chat). Returns the new
   *  message id when Telegram reports it (so callers can later edit it). */
  async sendMessage(
    text: string,
    opts: { chatId?: string; buttons?: InlineButton[][] } = {},
  ): Promise<{ ok: boolean; messageId: number | null }> {
    const body: Record<string, unknown> = {
      chat_id: opts.chatId ?? this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (opts.buttons && opts.buttons.length) body.reply_markup = toInlineKeyboard(opts.buttons);
    const res = await this.call('sendMessage', body);
    const result = res?.result as { message_id?: number } | undefined;
    return { ok: !!res?.ok, messageId: result?.message_id ?? null };
  }

  /** Replace a message's text (and its inline keyboard — pass [] to clear it). */
  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    opts: { buttons?: InlineButton[][] } = {},
  ): Promise<boolean> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true };
    // Always set reply_markup so leftover buttons are cleared when none are given.
    body.reply_markup = toInlineKeyboard(opts.buttons ?? []);
    const res = await this.call('editMessageText', body);
    return !!res?.ok;
  }

  /** Acknowledge a button tap (clears the client's spinner; optional toast). */
  async answerCallbackQuery(callbackQueryId: string, opts: { text?: string; showAlert?: boolean } = {}): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (opts.text) body.text = opts.text;
    if (opts.showAlert) body.show_alert = true;
    const res = await this.call('answerCallbackQuery', body);
    return !!res?.ok;
  }

  /** Register the inbound webhook (one-time, on boot). `secretToken` is echoed by
   *  Telegram in the X-Telegram-Bot-Api-Secret-Token header we verify. Returns the
   *  ok flag; on failure the description is logged for diagnosis. */
  async setWebhook(url: string, secretToken: string): Promise<boolean> {
    const res = await this.call('setWebhook', {
      url,
      secret_token: secretToken,
      // We only need messages + button taps; drop the rest to reduce noise.
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    if (res && !res.ok) log.error(`[telegram] setWebhook rejected: ${res.description ?? 'unknown'}`);
    return !!res?.ok;
  }
}
