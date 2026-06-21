# Plan — Telegram admin bot ("run the casino from your phone")

> ✅ **STATUS: SHIPPED (Phases 1–3, on `main`, not yet deployed).** Activate by setting
> `TELEGRAM_WEBHOOK_SECRET` (alongside the existing `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`)
> and pointing `CLIENT_ORIGIN` at your real https domain — the webhook self-registers on
> boot. Code: `notify/telegramBot.ts` (Bot API client), `telegram/adminBot.ts` (dispatcher),
> `http/telegramRoutes.ts` (webhook). Phase 1 = interactive withdrawals + /stats /withdrawals
> /treasury. Phase 2 = /user (freeze/suspend/ban) + /tickets + nightly digest. Phase 3 =
> /credit /debit /void /tournament (all confirm-gated). Every action reuses the audited
> panel services and is written to the admin audit trail.

> Goal: do the time-sensitive admin work (above all, **approving withdrawals**) straight
> from Telegram — tap a button on your phone instead of opening the admin panel. Reuses
> the **existing** Telegram bot you already get alerts from and the **existing, audited**
> admin/withdrawal services — the bot is only a front-end, it adds no new money logic.

## Why this is easy + safe to build
- **Outbound already exists.** `packages/server/src/notify/notifier.ts` (`TelegramNotifier`)
  already sends you a ping on every withdrawal request. We just make those messages
  *interactive* and add a few read commands.
- **The money actions already exist + are audited.** `WithdrawalService.approve(id, audit)`
  / `reject(id, audit)` (`money/withdrawals.ts:172/185`) are the exact methods the admin
  panel calls — idempotent (`setStatusIfPending`), ledger-safe, and recorded to the admin
  audit trail. The bot calls the SAME methods. No parallel money path.
- **One authorized user.** Only your `TELEGRAM_CHAT_ID` (already in `.env`) may issue
  commands; every other chat is ignored. That single check is the whole auth model for a
  solo operator.

## Architecture
```
Telegram  ──(button tap / command)──▶  POST /api/telegram/webhook  (Fastify, new route)
                                          │  guard: secret token + chat_id == TELEGRAM_CHAT_ID
                                          ▼
                                   TelegramBotService  ──▶  existing admin/withdrawal/
                                          │                  treasury services (audited)
                                          ▼
                                   reply / edit the message via the Bot API (notifier)
```
- **Inbound = a webhook**, not polling: Telegram already reaches your HTTPS domain (Caddy).
  Register it once with `setWebhook(url, secret_token)`; Telegram sends each update with an
  `X-Telegram-Bot-Api-Secret-Token` header we verify (mirror the existing
  `PAYMENT_WEBHOOK_SECRET` pattern). New env: `TELEGRAM_WEBHOOK_SECRET`.
- **TelegramBotService** wraps the Bot API methods we need beyond `sendMessage`:
  `sendMessage(..., reply_markup)` (inline buttons), `answerCallbackQuery`,
  `editMessageText` (so a resolved withdrawal's buttons turn into "✅ Approved by you").
- The owner maps to a real admin `userId` (the `ADMIN_EMAIL` account) so every bot action is
  written to the **same admin audit trail** as a panel action.

## What you'll be able to do — phased

### Phase 1 — withdrawals + at-a-glance stats (the 80%; ~1 focused day)
- **Interactive withdrawal alert (the killer feature).** The existing "new withdrawal: $X
  to T... (player, KYC)" message gains two buttons: **[✅ Approve] [❌ Reject]**. Tap Approve
  → `WithdrawalService.approve` runs, the message edits to "✅ Approved · $X · you · 12:04".
  Reject asks for a one-line reason (a follow-up message) → `reject(id, {reason})`. You never
  open the panel for the routine case.
- **`/stats`** → balance liabilities, # pending withdrawals, today's rake, treasury coverage
  OK/short (from the existing revenue/treasury services).
- **`/withdrawals`** → the pending queue, each row with its own Approve/Reject buttons.
- **`/treasury`** → Binance free, deposit-address funds, pending payouts, coverage flag
  (the same numbers as the admin Overview tab).
- Guard rails: a withdrawal above a configurable amount (e.g. `> $200`) requires a second
  tap ("Confirm $250 → T...?") before it fires; approve is idempotent so a double-tap is safe.

### Phase 2 — players + support (~half a day)
- **`/user <email|username>`** → account state, balance, KYC, lifetime, with **[Freeze]
  [Suspend 7d] [Ban] [Unfreeze]** buttons (→ `accountStateService`, audited, with a reason).
- **`/tickets`** → open support tickets; tap to read + **[Resolve]** with a note.
- A nightly **digest** (`08:00`): yesterday's signups, deposits, withdrawals, rake — pushed
  to you automatically (reuses the periodic sweep tick).

### Phase 3 — sensitive / occasional (~half a day, opt-in)
- **`/credit <user> <amount> <reason>` / `/debit …`** → balance adjust. ALWAYS a confirm tap,
  and (recommended) gated behind a higher-value second-confirm. Same `adminService.adjust`.
- **`/void <roomId> <reason>`** → cancel + refund a suspected-collusion live match.
- **`/tournament new <buyin> <cap>`**, **`/tournament cancel <id>`** → run tournaments from
  chat (now that they're self-running, "new" is all you usually need).

## Security model (important for real money)
1. **Single authorized chat.** Every update is dropped unless `message.chat.id` /
   `callback.from.id` equals `TELEGRAM_CHAT_ID`. (Optionally an allow-list for staff later.)
2. **Webhook secret.** Verify `X-Telegram-Bot-Api-Secret-Token` == `TELEGRAM_WEBHOOK_SECRET`
   on every request (fail closed), so nobody can POST fake updates to the endpoint.
3. **Same audited services.** No new credit/debit/approve logic — the bot calls the existing
   methods, so the ledger invariants, idempotency, and the admin audit trail all still hold.
4. **Confirm + cap on money out.** Large withdrawals / balance adjustments need a second tap;
   amounts are echoed back before firing.
5. **HTTPS only.** The webhook lives behind Caddy's TLS, like the rest of the API.

## Effort + rollout
- Phase 1 is the high-leverage slice and is self-contained: a webhook route, a
  `TelegramBotService`, inline buttons on the withdrawal alert, and 3–4 read commands.
  Estimate: **~1 focused day**. Phases 2–3 are ~half a day each and additive.
- New env: `TELEGRAM_WEBHOOK_SECRET` (and the existing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`).
- No DB migration. No change to the money paths. Fully removable (delete the route + service).

## Recommendation
Build **Phase 1** first — interactive withdrawal Approve/Reject + `/stats` / `/treasury` —
because withdrawals are the one thing that genuinely needs *you*, *quickly*, and that's
exactly what becomes a single phone tap. Say the word and I'll implement it.
