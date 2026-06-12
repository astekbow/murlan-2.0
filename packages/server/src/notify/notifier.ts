// ============================================================================
// MURLAN — Ops notifications (Telegram)
// ----------------------------------------------------------------------------
// Best-effort alerts to the operator (e.g. "new withdrawal request") so they
// don't have to poll the admin panel. The app depends only on the Notifier
// interface. notify() NEVER throws — a notification failure must not break a
// money flow (it's fired off the response path).
// ============================================================================

export interface Notifier {
  readonly name: string;
  notify(text: string): Promise<void>;
}

/** No channel configured → does nothing (the default). */
export class NullNotifier implements Notifier {
  readonly name = 'null';
  async notify(_text: string): Promise<void> { /* no-op */ }
}

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number }>;

/** Escape the HTML special chars Telegram's parse_mode=HTML cares about. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Sends a message to a Telegram chat via the Bot API sendMessage method. */
export class TelegramNotifier implements Notifier {
  readonly name = 'telegram';
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    // Injectable for tests; defaults to the global fetch (Node 18+/22).
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async notify(text: string): Promise<void> {
    try {
      const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (!res.ok) console.error(`[notify] telegram sendMessage failed: HTTP ${res.status}`);
    } catch (err) {
      // Best-effort: a Telegram/network hiccup must never bubble into the caller.
      console.error('[notify] telegram send error:', err);
    }
  }
}

/** Build a Telegram notifier when BOTH the token and chat id are set, else a no-op. */
export function createNotifier(cfg: { telegramBotToken: string | null; telegramChatId: string | null }): Notifier {
  if (cfg.telegramBotToken && cfg.telegramChatId) return new TelegramNotifier(cfg.telegramBotToken, cfg.telegramChatId);
  return new NullNotifier();
}
