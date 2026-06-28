// ============================================================================
// MURLAN — Telegram webhook (inbound updates for the admin bot)
// ----------------------------------------------------------------------------
// Telegram POSTs every button tap / command here. Auth is a single shared secret
// echoed in the X-Telegram-Bot-Api-Secret-Token header (set via setWebhook) —
// verified fail-closed so nobody can forge updates. The owner-chat check inside
// the dispatcher is the second gate. Mirrors the PAYMENT_WEBHOOK_SECRET pattern.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { TelegramAdminBot, TgUpdate } from '../telegram/adminBot.ts';

export interface TelegramRoutesDeps {
  adminBot: TelegramAdminBot;
  webhookSecret: string;
}

/** Constant-time secret compare (avoids a timing oracle on the token). */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function telegramRoutes(app: FastifyInstance, deps: TelegramRoutesDeps): Promise<void> {
  // Per-route cap (audit 2026-06-28): legit Telegram sends a handful of updates; this bounds a flood of
  // forged/spoofed POSTs (each does a timing-safe secret compare + dispatch) so they can't tie up the
  // event loop. 60/min/IP is generous for real traffic. The secret + owner-chat check remain the auth.
  app.post('/api/telegram/webhook', { config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req) => req.ip } } }, async (req, reply) => {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!secretMatches(provided, deps.webhookSecret)) {
      // Don't reveal anything — just 401 (the same as a missing/wrong secret).
      return reply.code(401).send({ error: { code: 'unauthorized' } });
    }
    // Process before replying (handleUpdate never throws + is quick); ack 200 so
    // Telegram doesn't retry. Body shape is validated leniently inside the dispatcher.
    await deps.adminBot.handleUpdate((req.body ?? {}) as TgUpdate);
    return reply.send({ ok: true });
  });
}
