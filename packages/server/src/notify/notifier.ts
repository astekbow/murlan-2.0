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
    // Retry a few times with backoff so a transient Telegram/network hiccup doesn't
    // silently drop an important alert (e.g. a large-withdrawal notice). Still
    // best-effort: after the last attempt we log and return — NEVER throw into the
    // caller (an alert failure must not affect a money flow).
    const ATTEMPTS = 3;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        });
        if (res.ok) return;
        // 4xx (bad token/chat id) won't fix on retry — log and stop; 5xx/429 may, so retry.
        if (res.status < 500 && res.status !== 429) {
          console.error(`[notify] telegram sendMessage failed: HTTP ${res.status} (not retryable)`);
          return;
        }
        console.error(`[notify] telegram sendMessage HTTP ${res.status} (attempt ${attempt}/${ATTEMPTS})`);
      } catch (err) {
        console.error(`[notify] telegram send error (attempt ${attempt}/${ATTEMPTS}):`, err);
      }
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt)); // 0.5s, then 1s
    }
  }
}

/** Build a Telegram notifier when BOTH the token and chat id are set, else a no-op. */
export function createNotifier(cfg: { telegramBotToken: string | null; telegramChatId: string | null }): Notifier {
  if (cfg.telegramBotToken && cfg.telegramChatId) return new TelegramNotifier(cfg.telegramBotToken, cfg.telegramChatId);
  return new NullNotifier();
}
