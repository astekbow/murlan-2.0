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

import { log } from '../logger.ts';
import { WithdrawalError, type WithdrawalService, type WithdrawalRecord } from '../money/withdrawals.ts';
import type { PayoutProvider } from '../money/payoutProvider.ts';
import type { AdminAuditRepository } from '../auth/adminAudit.ts';
import { checkAdjustGovernance } from '../money/adminAdjustPolicy.ts';
import { HOUSE_ACCOUNT_ID } from '../money/walletService.ts';
import { escapeHtml, type InlineButton } from '../notify/notifier.ts';
import type { TelegramBot } from '../notify/telegramBot.ts';
import type { SupportRepository, SupportTicket } from '../support/supportRepository.ts';

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
/** Sum player liabilities (real wallet balances), EXCLUDING the synthetic house account
 *  even if it somehow surfaced in the user list (money-23). */
function sumPlayerLiabilities(users: Array<{ balanceCents: number; id?: string }>): number {
  return users.reduce((s, u) => (u.id === HOUSE_ACCOUNT_ID ? s : s + (u.balanceCents || 0)), 0);
}
const SUSPEND_MS = 7 * 24 * 60 * 60 * 1000; // /user suspend = 7 days
const TICKET_REPLY_WINDOW_MS = 15 * 60 * 1000; // a staged free-text ticket reply expires after 15 min

/** Parse a USD amount ("5", "5.00", "$5") to positive integer cents, or null. */
function parseUsdToCents(s: string): number | null {
  const n = Number(String(s).replace(/^\$/, '').trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null;
}

/** The four admin-settable account states (mirrors accountStateSchema). */
export type AccountStateValue = 'active' | 'frozen' | 'suspended' | 'banned';

/** A user as the bot needs to show + act on them (Phase 2 /user). */
export interface UserSummary {
  id: string;
  username: string;
  email: string;
  role: string;
  balanceCents: number;
  kycStatus: string;
  accountState: string;
  accountStateReason: string | null;
  accountStateUntil: number | null;
  createdAt: number;
}

/** At-a-glance numbers for the nightly digest + /digest (computed by the caller). */
export interface DigestStats {
  players: number;
  newSignups24h: number;
  rake24hCents: number;
  pendingWithdrawals: number;
  pendingWithdrawalsCents: number;
  liabilitiesCents: number;
}

/** Risk snapshot shown before approving a withdrawal (all cheap reads). */
export interface UserRiskView {
  userId: string;
  username: string;
  accountAgeDays: number;
  kycStatus: string;
  accountState: string;
  balanceCents: number;
  priorWithdrawals: number;        // total ever (any status)
  completedWithdrawals: number;
  priorWithdrawalsCents: number;   // sum of completed payouts
  sameDayDepositWithdraw: boolean; // deposited AND withdrawing the same UTC day (cash-out abuse / laundering)
  /** Where the player's money CAME FROM — lifetime ledger sums (cents) — so the operator
   *  can tell at a glance if a cash-out is winnings vs just deposited funds passing through. */
  funds: {
    depositedCents: number;    // total deposited (top-ups / on-chain)
    wonCents: number;          // total won from pots (payout credits)
    wageredCents: number;      // total staked into pots (bet debits — negative)
    transferInCents: number;   // received from other players (P2P)
    transferOutCents: number;  // sent to other players (P2P — negative)
    netGameCents: number;      // won + wagered (net result of actually playing)
  };
}

/** One anti-cheat flag (mirrors SuspicionFlag) the operator can act on. */
export interface FlagView {
  id: string;
  userId: string;
  type: string;
  severity: number;
  detail: string;
  matchId: string | null;
  createdAt: number;
}

/** Live game snapshot for /live. */
export interface LiveState {
  matches: number;
  potCents: number;
  byType: Array<{ type: string; count: number; potCents: number }>;
}

/** Health snapshot for /health. */
export interface HealthState {
  dbOk: boolean | null; // null = no DB (in-memory)
  reconcileOk: boolean;
  mismatches: number;
  settlementFailures: number;
  activeMatches: number;
  pendingWithdrawals: number;
}

// ---- Minimal Telegram update shapes (only the fields we read) ----------------
interface TgChat { id: number | string }
interface TgFrom { id: number | string }
interface TgMessage { message_id: number; chat: TgChat; from?: TgFrom; text?: string }
interface TgCallbackQuery { id: string; from: TgFrom; message?: TgMessage; data?: string }
export interface TgUpdate { update_id?: number; message?: TgMessage; callback_query?: TgCallbackQuery }

/** Narrow read interface so the bot is easy to unit-test without a full wallet.
 *  `getHouseRakeCents` (money-23) sums the house rake from the LEDGER — getBalance of the
 *  synthetic house account is always 0, so a treasury view must use this or it masks a
 *  rake siphon by always reading $0. */
export interface BalanceReader {
  getBalance(accountId: string): Promise<number>;
  getHouseRakeCents?(): Promise<number>;
}

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
  /** Sum of player balances = house liability. The synthetic house account is never a
   *  User row, so it's already excluded; `id` is optional + filtered defensively (money-23). */
  listUsers: () => Promise<Array<{ balanceCents: number; id?: string }>>;
  /** Withdrawals at/above this need a second confirm tap. 0 = always one-tap. */
  largeWithdrawalCents: number;
  /** Optional: Binance Spot free USDT (cents) for /treasury coverage (null if unknown). */
  binanceFreeUsdtCents?: () => Promise<number | null>;

  // ---- Phase 2 (players + support + digest) — all optional ----
  /** Look up a user by email or username (for /user). */
  findUser?: (query: string) => Promise<UserSummary | null>;
  /** Resolve a userId → its username (so the operator sees names, not raw ids, everywhere). */
  usernameFor?: (userId: string) => Promise<string | null>;
  /** Apply an account state (freeze/suspend/ban/reactivate). Returns false if not found. */
  setAccountState?: (userId: string, patch: { state: AccountStateValue; reason: string | null; until: number | null }) => Promise<boolean>;
  /** Force-disconnect a user's live sockets (on ban/suspend), mirrors the panel. */
  kickUser?: (userId: string) => void;
  /** Support/dispute ticket store (for /tickets + resolve). */
  support?: SupportRepository;
  /** At-a-glance stats for the nightly digest + /digest. */
  digest?: () => Promise<DigestStats>;

  // ---- Phase 3 (sensitive / occasional) — all optional, all confirm-gated ----
  /** Manual balance adjust (credit/debit). deltaCents>0 credits, <0 debits.
   *  `opts.txId` (CREDIT only) makes the credit idempotent against a player TxID claim
   *  of the same on-chain deposit (money-2): `ok:false, reason:'already_credited'` if
   *  the TxID was already booked. */
  adminAdjust?: (userId: string, deltaCents: number, reason: string, opts?: { txId?: string }) => Promise<{ ok: true; balanceCents: number; idempotent?: boolean } | { ok: false; reason: string }>;
  /** admin-6: require a 2nd distinct admin to confirm a manual adjustment. OFF by default. */
  adjustDualControl?: boolean;
  /** Void + refund a live match (collusion). */
  voidMatch?: (roomId: string, meta: { adminId: string; reason: string }) => Promise<{ ok: true; matchId: string | null; refunded: boolean } | { ok: false; reason: string }>;
  /** Create a tournament (empty; players join via the app — buy-ins debit on join). */
  tournamentCreate?: (name: string, buyInCents: number, capacity: number) => Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string }>;
  /** Cancel + refund a tournament. */
  tournamentCancel?: (id: string) => Promise<{ ok: true } | { ok: false; reason: string }>;

  // ---- Tier-2 power-ups — all optional ----
  /** Risk snapshot for a user (shown via the [👤 Rreziku] button before approving). */
  userRisk?: (userId: string, anchorMs?: number) => Promise<UserRiskView | null>;
  /** Anti-cheat flags (collusion / chip-dump / bot), newest first. */
  listFlags?: (minSeverity: number, limit: number) => Promise<FlagView[]>;
  /** Send a player an in-app push notification (e.g. ticket resolved, withdrawal rejected). */
  messagePlayer?: (userId: string, title: string, body: string) => Promise<void>;
  /** Live game snapshot (active matches + pot at risk). */
  liveState?: () => Promise<LiveState>;
  /** Health snapshot (DB, reconcile, settlement failures, live counts). */
  health?: () => Promise<HealthState>;
  /** On-chain USDT sitting in the per-player deposit addresses (awaiting a sweep). */
  depositFunds?: () => Promise<{ totalCents: number; funded: Array<{ address: string; cents: number }>; partial: boolean } | null>;
}

/** A money-moving action staged for a confirm tap (its reason text is too long /
 *  unsafe to round-trip through Telegram's 64-byte callback_data, so we hold it
 *  server-side keyed by a short id). */
interface PendingAction {
  kind: 'adjust' | 'void';
  summary: string; // human echo shown on the confirm prompt
  createdAt: number;
  // telegram-2/3: the sender id (from.id) that STAGED this action. The confirm tap must
  // come from the SAME sender — a staged money move can't be confirmed by a different id.
  stagedBy: string | undefined;
  run: () => Promise<string>; // executes the action, returns the result line
}
const PENDING_TTL_MS = 10 * 60 * 1000; // a staged confirm expires after 10 min

/** Where to edit the message a callback came from. */
interface MessageRef { chatId: number | string; messageId: number | null }

export class TelegramAdminBot {
  private readonly pending = new Map<string, PendingAction>();
  private pendingSeq = 0;
  // A staged free-text ticket reply: the owner's NEXT plain (non-command) message becomes
  // the reply that's sent to the player + resolves the ticket. Cleared by a command or timeout.
  private pendingReply: { ticketId: string; subject: string; at: number } | null = null;
  // The sender id (from.id) of the message currently being handled — captured so a confirm-
  // gated action staged by it is bound to that sender (telegram-2/3).
  private currentSenderId: string | undefined;

  constructor(private readonly deps: AdminBotDeps) {}

  /** Stage a confirm-gated action; returns its short key for the confirm callback. The
   *  staging sender (the current message's from.id) is recorded so only that sender can
   *  confirm it (telegram-2/3). */
  private stagePending(a: Omit<PendingAction, 'stagedBy'>): string {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    const key = `p${(this.pendingSeq += 1)}`;
    this.pending.set(key, { ...a, stagedBy: this.currentSenderId });
    return key;
  }

  private isAuthorized(chatId: number | string | undefined): boolean {
    return chatId !== undefined && String(chatId) === this.deps.authorizedChatId;
  }

  /** Authorize an update on the SENDER's id (`from.id`) — telegram-2/3. When `from.id` is
   *  present it is the ONLY thing checked (a group member's from.id never matches the
   *  owner). Only when Telegram omits `from` entirely (rare: e.g. a >48h-old message-less
   *  callback) do we fall back to the chat id — and that's safe because the boot guard
   *  rejects a GROUP (negative) TELEGRAM_CHAT_ID, so the authorized chat is always the
   *  owner's PRIVATE chat (chat.id == the owner's id). This closes the "chat.id OR from.id"
   *  hole (a group turning every member into a money admin) without breaking message-less taps. */
  private isAuthorizedTap(chatId: number | string | undefined, fromId: number | string | undefined): boolean {
    if (fromId !== undefined) return this.isAuthorized(fromId); // sender-only when known
    return this.isAuthorized(chatId); // from-less update → private-chat fallback (boot-guarded)
  }

  /** Single entry point for a Telegram update. NEVER throws (the webhook always 200s). */
  async handleUpdate(update: TgUpdate): Promise<void> {
    try {
      if (update.callback_query) return await this.handleCallback(update.callback_query);
      if (update.message?.text) return await this.handleMessage(update.message);
    } catch (err) {
      log.error('[telegram-bot] handleUpdate error:', err);
    }
  }

  // ---- Commands ----------------------------------------------------------------
  private async handleMessage(msg: TgMessage): Promise<void> {
    if (!this.isAuthorizedTap(msg.chat.id, msg.from?.id)) return; // silently ignore strangers
    // Bind any confirm-gated action this message stages to the sender (telegram-2/3).
    this.currentSenderId = msg.from?.id !== undefined ? String(msg.from.id) : undefined;
    const text = msg.text!.trim();
    // A staged ticket reply captures the owner's NEXT plain (non-command) message as the
    // reply that goes to the player; typing a command instead cancels the staged reply.
    if (this.pendingReply && !text.startsWith('/')) {
      const pend = this.pendingReply;
      this.pendingReply = null;
      if (Date.now() - pend.at > TICKET_REPLY_WINDOW_MS) {
        return void (await this.deps.bot.sendMessage('⌛ Skadoi koha për përgjigje. Shtyp prapë “💬 Përgjigju”.'));
      }
      return void (await this.submitTicketReply(pend.ticketId, text));
    }
    this.pendingReply = null;
    const tokens = text.split(/\s+/);
    const cmd = (tokens[0] ?? '').replace(/@.*$/, '').toLowerCase();
    const arg = tokens.slice(1).join(' ').trim();
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
      case '/user':
        return void (await this.sendUser(arg));
      case '/tickets':
        return void (await this.sendTickets());
      case '/digest':
        return void (await this.sendDigest());
      case '/credit':
        return void (await this.stageAdjust(arg, +1));
      case '/debit':
        return void (await this.stageAdjust(arg, -1));
      case '/void':
        return void (await this.stageVoid(arg));
      case '/tournament':
        return void (await this.handleTournament(arg));
      case '/flags':
        return void (await this.sendFlags());
      case '/live':
        return void (await this.sendLive());
      case '/health':
        return void (await this.sendHealth());
      case '/deposits':
        return void (await this.sendDeposits());
      default:
        return void (await this.deps.bot.sendMessage(`Urdhër i panjohur. ${escapeHtml('/help')} për listën.`));
    }
  }

  private helpText(): string {
    const lines = [
      '🤖 <b>Murlan — admin bot</b>',
      'Tërheqjet e reja vijnë me butona [✅ Aprovo] [❌ Refuzo].',
      '',
      '/withdrawals — radha e tërheqjeve në pritje',
      '/stats — bilanc, detyrime, tërheqje në pritje',
      '/treasury — mbulimi i arkës',
    ];
    if (this.deps.findUser) lines.push('/user &lt;email|username&gt; — llogaria + butona Ngrij/Pezullo/Blloko');
    if (this.deps.support) lines.push('/tickets — biletat e hapura të suportit');
    if (this.deps.digest) lines.push('/digest — përmbledhja e 24 orëve');
    if (this.deps.adminAdjust) lines.push('/credit &lt;user&gt; &lt;shuma&gt; &lt;arsye&gt; · /debit … — rregullim bilanci (me konfirmim)');
    if (this.deps.voidMatch) lines.push('/void &lt;roomId&gt; &lt;arsye&gt; — anulo + rikthe një ndeshje (me konfirmim)');
    if (this.deps.tournamentCreate) lines.push('/tournament new &lt;buyin&gt; &lt;cap&gt; · /tournament cancel &lt;id&gt;');
    if (this.deps.listFlags) lines.push('/flags — sinjale anti-cheat (koluzion/bot)');
    if (this.deps.liveState) lines.push('/live — ndeshjet aktive + lekët në lojë tani');
    if (this.deps.health) lines.push('/health — a është gjithçka në rregull');
    if (this.deps.depositFunds) lines.push('/deposits — USDT i paprekur te adresat (për sweep)');
    lines.push('/help — kjo listë');
    return lines.join('\n');
  }

  // ---- Phase 2: /user (account state) ----------------------------------------
  private async sendUser(query: string): Promise<void> {
    if (!this.deps.findUser) return void (await this.deps.bot.sendMessage('Komanda /user s’është aktive.'));
    if (!query) return void (await this.deps.bot.sendMessage('Përdorimi: <code>/user email-ose-username</code>'));
    const u = await this.deps.findUser(query).catch(() => null);
    if (!u) return void (await this.deps.bot.sendMessage(`Nuk u gjet asnjë përdorues për “${escapeHtml(query)}”.`));
    const r = this.renderUser(u);
    await this.deps.bot.sendMessage(r.text, { buttons: r.buttons });
  }

  private renderUser(u: UserSummary): { text: string; buttons: InlineButton[][] } {
    const joined = new Date(u.createdAt).toISOString().slice(0, 10);
    const stateLine = u.accountState === 'active'
      ? '✅ aktive'
      : `⛔ ${escapeHtml(u.accountState)}${u.accountStateReason ? ` (${escapeHtml(u.accountStateReason)})` : ''}`;
    const text =
      `👤 <b>${escapeHtml(u.username)}</b>${u.role === 'admin' ? ' · admin' : ''}\n` +
      `Email: ${escapeHtml(u.email)}\n` +
      `Bilanci: <b>${usd(u.balanceCents)}</b>\n` +
      `KYC: ${escapeHtml(u.kycStatus)}\n` +
      `Gjendja: ${stateLine}\n` +
      `Regjistruar: ${joined}`;
    // Show only the actions that change something from the current state.
    const buttons: InlineButton[][] = [];
    const row: InlineButton[] = [];
    if (u.accountState !== 'frozen') row.push({ text: '🧊 Ngrij', callbackData: `us:freeze:${u.id}` });
    if (u.accountState !== 'suspended') row.push({ text: '⏸ Pezullo 7d', callbackData: `us:susp:${u.id}` });
    if (u.accountState !== 'banned') row.push({ text: '🚫 Blloko', callbackData: `us:ban:${u.id}` });
    if (row.length) buttons.push(row);
    if (u.accountState !== 'active') buttons.push([{ text: '✅ Riakto', callbackData: `us:active:${u.id}` }]);
    return { text, buttons };
  }

  private async applyAccountState(userId: string, state: AccountStateValue, ref: MessageRef): Promise<void> {
    if (!this.deps.setAccountState) { await this.editResolved(ref, 'Veprimi s’është aktiv.'); return; }
    const adminId = await this.deps.resolveAdminUserId();
    if (!adminId) { await this.editResolved(ref, '⚠️ S’u gjet llogaria admin (ADMIN_EMAIL) — veprimi u ndal.'); return; }
    const until = state === 'suspended' ? Date.now() + SUSPEND_MS : null;
    const reason = 'Caktuar nga admini (Telegram)';
    const ok = await this.deps.setAccountState(userId, { state, reason, until }).catch(() => false);
    if (!ok) { await this.editResolved(ref, '⚠️ Përdoruesi nuk u gjet.'); return; }
    // Ban/suspend: also drop live sockets (mirrors the panel).
    if (state === 'banned' || state === 'suspended') this.deps.kickUser?.(userId);
    await this.deps.audit.record({ adminId, action: 'account_state_set', targetUserId: userId, detail: `${state} (telegram)` });
    const label: Record<AccountStateValue, string> = { active: '✅ Riaktivizuar', frozen: '🧊 Ngrirë', suspended: '⏸ Pezulluar 7 ditë', banned: '🚫 Bllokuar' };
    // Re-fetch so the message reflects the new state + offers the remaining actions.
    const u = this.deps.findUser ? await this.deps.findUser(userId).catch(() => null) : null;
    if (u && ref.messageId !== null) {
      const r = this.renderUser(u);
      await this.editMessage(ref, `${label[state]} ✓\n\n${r.text}`, r.buttons);
    } else {
      await this.editResolved(ref, `${label[state]} ✓`);
    }
  }

  // ---- Phase 2: /tickets ------------------------------------------------------
  private async sendTickets(): Promise<void> {
    if (!this.deps.support) return void (await this.deps.bot.sendMessage('Komanda /tickets s’është aktive.'));
    const all = await this.deps.support.list(50).catch(() => [] as SupportTicket[]);
    const open = all.filter((t) => t.status === 'open');
    if (!open.length) return void (await this.deps.bot.sendMessage('✅ S’ka bileta të hapura.'));
    const CAP = 10;
    await this.deps.bot.sendMessage(`🎫 <b>${open.length}</b> bileta të hapura${open.length > CAP ? ` (po shfaq ${CAP})` : ''}:`);
    for (const t of open.slice(0, CAP)) {
      await this.deps.bot.sendMessage(this.renderTicket(t, await this.nameFor(t.userId)), { buttons: this.ticketButtons(t.id) });
    }
  }

  /** Resolve a userId → its username for display (raw ids are noise for the operator).
   *  Falls back to a short id if the lookup isn't wired or the user is gone. */
  private async nameFor(userId: string): Promise<string> {
    const name = this.deps.usernameFor ? await this.deps.usernameFor(userId).catch(() => null) : null;
    return name ?? `#${userId.slice(0, 8)}`;
  }

  private renderTicket(t: SupportTicket, playerName: string): string {
    const msg = t.message.length > 240 ? `${t.message.slice(0, 240)}…` : t.message;
    return (
      `🎫 <b>${escapeHtml(t.subject)}</b> · ${escapeHtml(t.category)}\n` +
      `${escapeHtml(msg)}\n` +
      (t.matchId ? `Ndeshja: <code>${escapeHtml(t.matchId)}</code>\n` : '') +
      `Lojtari: <b>${escapeHtml(playerName)}</b>`
    );
  }

  private async resolveTicket(id: string, ref: MessageRef): Promise<void> {
    if (!this.deps.support) { await this.editResolved(ref, 'Veprimi s’është aktiv.'); return; }
    const adminId = await this.deps.resolveAdminUserId();
    if (!adminId) { await this.editResolved(ref, '⚠️ S’u gjet llogaria admin (vendos ADMIN_EMAIL te .env) — veprimi u ndal.'); return; }
    const t = await this.deps.support.resolve(id, 'resolved', 'Zgjidhur nga admini (Telegram)', Date.now()).catch(() => null);
    if (!t) { await this.editResolved(ref, '⚠️ Bileta nuk u gjet.'); return; }
    await this.deps.audit.record({ adminId, action: 'support_resolve', targetUserId: t.userId, detail: `${id} (telegram)` });
    // Close the loop: notify the player their ticket was handled (best-effort).
    let notified = '';
    if (this.deps.messagePlayer) {
      await this.deps.messagePlayer(t.userId, 'Mbështetje — zgjidhur', `Kërkesa jote “${t.subject}” u shqyrtua dhe u zgjidh.`).then(() => { notified = ' · lojtari u njoftua'; }).catch(() => {});
    }
    await this.editResolved(ref, `✅ <b>Zgjidhur</b> · ${escapeHtml(t.subject)}${notified}`);
  }

  // ---- Phase 2: digest (manual /digest + nightly) ----------------------------
  /** Build + send the 24h digest. Public so the nightly sweep can call it. */
  async sendDigest(): Promise<void> {
    if (!this.deps.digest) { await this.deps.bot.sendMessage('Përmbledhja s’është aktive.'); return; }
    const d = await this.deps.digest().catch(() => null);
    if (!d) { await this.deps.bot.sendMessage('⚠️ Nuk u llogarit dot përmbledhja.'); return; }
    await this.deps.bot.sendMessage(
      '🌅 <b>Përmbledhja e 24 orëve</b>\n' +
      `Lojtarë gjithsej: <b>${d.players}</b> (+${d.newSignups24h} të rinj)\n` +
      `Rake 24h: <b>${usd(d.rake24hCents)}</b>\n` +
      `Tërheqje në pritje: ${d.pendingWithdrawals} (${usd(d.pendingWithdrawalsCents)})\n` +
      `Detyrime lojtarësh: ${usd(d.liabilitiesCents)}`,
    );
  }

  // ---- Phase 3: balance adjust (/credit /debit) — confirm-gated ---------------
  /** sign = +1 for credit, -1 for debit. arg = "user amount reason…". */
  private async stageAdjust(arg: string, sign: 1 | -1): Promise<void> {
    if (!this.deps.adminAdjust || !this.deps.findUser) return void (await this.deps.bot.sendMessage('Komanda s’është aktive.'));
    const parts = arg.split(/\s+/).filter(Boolean);
    const verb = sign > 0 ? 'credit' : 'debit';
    if (parts.length < 2) return void (await this.deps.bot.sendMessage(`Përdorimi: <code>/${verb} user shuma arsye</code>`));
    const cents = parseUsdToCents(parts[1]!);
    if (cents === null) return void (await this.deps.bot.sendMessage('Shumë e pavlefshme (p.sh. 5 ose 5.00).'));
    // A CREDIT may carry a TRON TxID (64 hex) anywhere in the trailing args — pull it out
    // so the credit is idempotent against a later player claim of the same deposit
    // (money-2). It's removed from the reason text. (Debits never take a TxID.)
    const tail = parts.slice(2);
    let txId: string | undefined;
    if (sign > 0) {
      const idx = tail.findIndex((p) => /^[0-9a-fA-F]{64}$/.test(p));
      if (idx >= 0) { txId = tail[idx]!.toLowerCase(); tail.splice(idx, 1); }
    }
    const reason = tail.join(' ').trim() || `${verb} (Telegram)`;
    const u = await this.deps.findUser(parts[0]!).catch(() => null);
    if (!u) return void (await this.deps.bot.sendMessage(`Nuk u gjet përdoruesi “${escapeHtml(parts[0]!)}”.`));
    const delta = sign * cents;
    const adjust = this.deps.adminAdjust;
    const key = this.stagePending({
      kind: 'adjust',
      summary: `${sign > 0 ? '➕ Kredito' : '➖ Debito'} <b>${usd(cents)}</b> ${sign > 0 ? '→' : 'nga'} ${escapeHtml(u.username)}\nArsyeja: ${escapeHtml(reason)}${txId ? `\nTxID: <code>${escapeHtml(txId)}</code>` : ''}`,
      createdAt: Date.now(),
      run: async () => {
        const adminId = await this.deps.resolveAdminUserId();
        if (!adminId) return '⚠️ S’u gjet llogaria admin (vendos ADMIN_EMAIL te .env) — veprimi u ndal.';
        // SAME governance as the panel (admin-6): per-call ceiling + per-admin 24h cap + no
        // self-credit — so the Telegram path is not a softer door than the HTTP route.
        const gov = await checkAdjustGovernance(this.deps.audit, adminId, u.id, delta, { dualControl: this.deps.adjustDualControl });
        if (!gov.ok) return `⚠️ ${escapeHtml(gov.message)}`;
        const res = await adjust(u.id, delta, reason, txId ? { txId } : undefined).catch(() => ({ ok: false, reason: 'gabim' } as const));
        if (!res.ok) {
          if (res.reason === 'already_credited') return '⚠️ Kjo depozitë (TxID) është kredituar tashmë — nuk u dyfishua.';
          return `⚠️ ${res.reason === 'insufficient_funds' ? 'Bilanc i pamjaftueshëm për debitim.' : escapeHtml(res.reason)}`;
        }
        await this.deps.audit.record({ adminId, action: 'balance_adjust', targetUserId: u.id, amountCents: delta, detail: `${reason} (telegram)${txId ? ` [tron:${txId}]` : ''}` });
        return `✅ <b>${sign > 0 ? 'Kredituar' : 'Debituar'}</b> ${usd(cents)} · ${escapeHtml(u.username)} · bilanci: <b>${usd(res.balanceCents)}</b>`;
      },
    });
    await this.sendConfirm(key);
  }

  // ---- Phase 3: void a live match (/void) — confirm-gated --------------------
  private async stageVoid(arg: string): Promise<void> {
    if (!this.deps.voidMatch) return void (await this.deps.bot.sendMessage('Komanda /void s’është aktive.'));
    const parts = arg.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return void (await this.deps.bot.sendMessage('Përdorimi: <code>/void roomId arsye</code>'));
    const roomId = parts[0]!;
    const reason = parts.slice(1).join(' ').trim();
    const voidMatch = this.deps.voidMatch;
    const key = this.stagePending({
      kind: 'void',
      summary: `🛑 Anulo + rikthe ndeshjen <code>${escapeHtml(roomId)}</code>\nArsyeja: ${escapeHtml(reason)}`,
      createdAt: Date.now(),
      run: async () => {
        const adminId = await this.deps.resolveAdminUserId();
        if (!adminId) return '⚠️ S’u gjet llogaria admin (vendos ADMIN_EMAIL te .env) — veprimi u ndal.';
        const res = await voidMatch(roomId, { adminId, reason }).catch(() => ({ ok: false, reason: 'gabim' } as const));
        if (!res.ok) return `⚠️ Nuk u anulua (${escapeHtml(res.reason)}).`;
        await this.deps.audit.record({ adminId, action: 'match_void', detail: `${roomId} (telegram, refunded=${res.refunded}): ${reason}` });
        return `✅ <b>Anuluar</b> · ndeshja <code>${escapeHtml(roomId)}</code> · rikthim: ${res.refunded ? 'po' : 'jo'}`;
      },
    });
    await this.sendConfirm(key);
  }

  private async sendConfirm(key: string): Promise<void> {
    const a = this.pending.get(key);
    if (!a) return;
    await this.deps.bot.sendMessage(
      `⚠️ <b>Konfirmo</b>\n${a.summary}`,
      { buttons: [[{ text: '✅ Konfirmo', callbackData: `pa:ok:${key}` }, { text: '✖️ Anulo', callbackData: `pa:x:${key}` }]] },
    );
  }

  // ---- Phase 3: tournaments (/tournament new|cancel) -------------------------
  private async handleTournament(arg: string): Promise<void> {
    if (!this.deps.tournamentCreate || !this.deps.tournamentCancel) return void (await this.deps.bot.sendMessage('Komanda /tournament s’është aktive.'));
    const parts = arg.split(/\s+/).filter(Boolean);
    const sub = (parts[0] ?? '').toLowerCase();
    if (sub === 'new') {
      const cents = parseUsdToCents(parts[1] ?? '');
      const cap = Number(parts[2]);
      if (cents === null) return void (await this.deps.bot.sendMessage('Buy-in i pavlefshëm (p.sh. 5).'));
      if (![2, 4, 8].includes(cap)) return void (await this.deps.bot.sendMessage('Kapaciteti duhet të jetë 2, 4 ose 8.'));
      const name = parts.slice(3).join(' ').trim() || `Turne $${(cents / 100).toFixed(0)}`;
      const res = await this.deps.tournamentCreate(name, cents, cap).catch(() => ({ ok: false, reason: 'gabim' } as const));
      if (!res.ok) return void (await this.deps.bot.sendMessage(`⚠️ Nuk u krijua (${escapeHtml(res.reason)}).`));
      const adminId = await this.deps.resolveAdminUserId();
      if (adminId) await this.deps.audit.record({ adminId, action: 'tournament_create', detail: `${res.id} "${res.name}" buyIn=${cents} cap=${cap} (telegram)` });
      return void (await this.deps.bot.sendMessage(`✅ <b>Turne i krijuar</b> · ${escapeHtml(res.name)} · buy-in ${usd(cents)} · ${cap} lojtarë\nID: <code>${escapeHtml(res.id)}</code>`));
    }
    if (sub === 'cancel') {
      const id = parts[1];
      if (!id) return void (await this.deps.bot.sendMessage('Përdorimi: <code>/tournament cancel id</code>'));
      const res = await this.deps.tournamentCancel(id).catch(() => ({ ok: false, reason: 'gabim' } as const));
      if (!res.ok) return void (await this.deps.bot.sendMessage(`⚠️ Nuk u anulua (${escapeHtml(res.reason)}).`));
      const adminId = await this.deps.resolveAdminUserId();
      if (adminId) await this.deps.audit.record({ adminId, action: 'tournament_cancel', detail: `${id} (telegram)` });
      return void (await this.deps.bot.sendMessage(`✅ <b>Turneu u anulua</b> · buy-in-et u rikthyen · <code>${escapeHtml(id)}</code>`));
    }
    await this.deps.bot.sendMessage('Përdorimi: <code>/tournament new buyin cap</code> ose <code>/tournament cancel id</code>');
  }

  /** Accumulated house rake from the LEDGER (money-23) — getBalance(house) is always 0. */
  private async houseRakeCents(): Promise<number> {
    if (this.deps.wallet.getHouseRakeCents) return this.deps.wallet.getHouseRakeCents().catch(() => 0);
    return this.deps.wallet.getBalance(HOUSE_ACCOUNT_ID).catch(() => 0); // legacy fallback
  }

  private async sendStats(): Promise<void> {
    const [house, users, pending] = await Promise.all([
      this.houseRakeCents(),
      this.deps.listUsers().catch(() => []),
      this.deps.withdrawals.listPending().catch(() => []),
    ]);
    const liabilities = sumPlayerLiabilities(users);
    const pendTotal = pending.reduce((s, w) => s + w.amountCents, 0);
    await this.deps.bot.sendMessage(
      '📊 <b>Statistika</b>\n' +
      `Të ardhura (rake): <b>${usd(house)}</b>\n` +
      `Detyrime lojtarësh: ${usd(liabilities)}\n` +
      `Tërheqje në pritje: <b>${pending.length}</b> (${usd(pendTotal)})`,
    );
  }

  private async sendTreasury(): Promise<void> {
    const [house, users, pending, binanceFree] = await Promise.all([
      this.houseRakeCents(),
      this.deps.listUsers().catch(() => []),
      this.deps.withdrawals.listPending().catch(() => []),
      this.deps.binanceFreeUsdtCents ? this.deps.binanceFreeUsdtCents().catch(() => null) : Promise.resolve(null),
    ]);
    const liabilities = sumPlayerLiabilities(users);
    const pendTotal = pending.reduce((s, w) => s + w.amountCents, 0);
    let lines =
      '🏦 <b>Arka</b>\n' +
      `Të ardhura (rake): <b>${usd(house)}</b>\n` +
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
    const buttons: InlineButton[][] = [[
      { text: '✅ Aprovo', callbackData: `wd:ok:${w.id}` },
      { text: '❌ Refuzo', callbackData: `wd:no:${w.id}` },
    ]];
    if (this.deps.userRisk) buttons.push([{ text: '👤 Rreziku', callbackData: `wd:risk:${w.id}` }]);
    return {
      text:
        `⏳ <b>Tërheqje</b> · ${usd(w.amountCents)}\n` +
        `Adresa: <code>${escapeHtml(w.destination)}</code>`,
      buttons,
    };
  }

  // ---- Button taps -------------------------------------------------------------
  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    const ref: MessageRef = { chatId: cq.message?.chat.id ?? this.deps.authorizedChatId, messageId: cq.message?.message_id ?? null };
    // Auth: drop taps unless the owner's chat OR the owner themselves tapped (still
    // answer to clear the spinner). The dual check keeps >48h-old (message-less) taps
    // working for the single private operator chat.
    if (!this.isAuthorizedTap(cq.message?.chat.id, cq.from.id)) {
      await this.deps.bot.answerCallbackQuery(cq.id, { text: 'I paautorizuar.' });
      return;
    }
    const parts = (cq.data ?? '').split(':');
    const domain = parts[0];
    const action = parts[1];
    const id = parts.slice(2).join(':');
    if (!id) { await this.deps.bot.answerCallbackQuery(cq.id); return; }
    if (domain === 'wd') return await this.handleWithdrawalTap(action, id, ref, cq.id);
    if (domain === 'us') return await this.handleAccountStateTap(action, id, ref, cq.id);
    if (domain === 'tk') return await this.handleTicketTap(action, id, ref, cq.id);
    if (domain === 'pa') return await this.handlePendingTap(action, id, ref, cq.id, String(cq.from.id));
    await this.deps.bot.answerCallbackQuery(cq.id);
  }

  /** Confirm (pa:ok) / cancel (pa:x) a staged money-moving action. */
  private async handlePendingTap(action: string | undefined, key: string, ref: MessageRef, cbId: string, tapperId: string): Promise<void> {
    const a = this.pending.get(key);
    if (action === 'x') {
      this.pending.delete(key);
      await this.deps.bot.answerCallbackQuery(cbId, { text: 'Anuluar.' });
      await this.editResolved(ref, '✖️ Anuluar.');
      return;
    }
    if (action !== 'ok') { await this.deps.bot.answerCallbackQuery(cbId); return; }
    if (!a) {
      await this.deps.bot.answerCallbackQuery(cbId, { text: 'Skadoi — provoje sërish.', showAlert: true });
      await this.editResolved(ref, '⌛ Konfirmimi skadoi — dërgoje sërish komandën.');
      return;
    }
    // telegram-2/3: the confirm must come from the SAME sender that staged the action.
    // (Both are the single authorized operator today; this binds the two-step flow.)
    if (a.stagedBy !== undefined && a.stagedBy !== tapperId) {
      await this.deps.bot.answerCallbackQuery(cbId, { text: 'I paautorizuar për këtë veprim.', showAlert: true });
      return;
    }
    // One-shot: remove BEFORE running so a double-tap can't execute twice.
    this.pending.delete(key);
    await this.deps.bot.answerCallbackQuery(cbId, { text: 'Po e zbatoj…' });
    const result = await a.run().catch((e) => `⚠️ Gabim: ${escapeHtml(String(e))}`);
    await this.editResolved(ref, result);
  }

  private async handleWithdrawalTap(action: string | undefined, id: string, ref: MessageRef, cbId: string): Promise<void> {
    switch (action) {
      case 'ok': // approve (may step up to a confirm for large amounts)
        await this.onApproveTap(id, ref, cbId);
        break;
      case 'cfm': // confirmed approve (second tap)
        await this.deps.bot.answerCallbackQuery(cbId, { text: 'Po e dërgoj…' });
        await this.doApprove(id, ref);
        break;
      case 'x': // cancel a pending confirm → restore the row
        await this.onCancelConfirm(id, ref, cbId);
        break;
      case 'no': // reject
        await this.deps.bot.answerCallbackQuery(cbId, { text: 'Po e refuzoj…' });
        await this.doReject(id, ref);
        break;
      case 'risk': // show the user's risk snapshot (as a NEW message; the alert stays actionable)
        await this.deps.bot.answerCallbackQuery(cbId);
        await this.showWithdrawalRisk(id);
        break;
      default:
        await this.deps.bot.answerCallbackQuery(cbId);
    }
  }

  private async handleAccountStateTap(action: string | undefined, id: string, ref: MessageRef, cbId: string): Promise<void> {
    if (action === 'show') { // open the full user card (e.g. tapped from a /flags row)
      await this.deps.bot.answerCallbackQuery(cbId);
      await this.sendUser(id);
      return;
    }
    const map: Record<string, AccountStateValue> = { freeze: 'frozen', susp: 'suspended', ban: 'banned', active: 'active' };
    const state = action ? map[action] : undefined;
    if (!state) { await this.deps.bot.answerCallbackQuery(cbId); return; }
    await this.deps.bot.answerCallbackQuery(cbId, { text: 'Po e zbatoj…' });
    await this.applyAccountState(id, state, ref);
  }

  // ---- Tier-2: withdrawal risk snapshot --------------------------------------
  private async showWithdrawalRisk(withdrawalId: string): Promise<void> {
    if (!this.deps.userRisk) return;
    const w = await this.deps.withdrawals.find(withdrawalId).catch(() => null);
    if (!w) return void (await this.deps.bot.sendMessage('⚠️ Tërheqja nuk u gjet.'));
    // Anchor the same-day deposit→withdraw check on THIS withdrawal's own day (not
    // "today"), so an overnight-pending withdrawal is still judged against its real day.
    const r = await this.deps.userRisk(w.userId, w.createdAt).catch(() => null);
    if (!r) return void (await this.deps.bot.sendMessage('⚠️ S’u lexua dot profili i rrezikut.'));
    const f = r.funds;
    const flags: string[] = [];
    if (r.sameDayDepositWithdraw) flags.push('⚠️ Depozitoi DHE po tërheq të njëjtën ditë');
    // Cashing out money that was DEPOSITED (or received), not WON — a laundering / pass-through signal.
    if (f.netGameCents <= 0 && f.depositedCents + f.transferInCents > 0) flags.push('⚠️ Po tërheq fonde të depozituara/marra, JO fitime nga loja');
    if (r.accountAgeDays < 1) flags.push('⚠️ Llogari < 24h e vjetër');
    if (r.kycStatus !== 'verified') flags.push(`KYC: ${escapeHtml(r.kycStatus)}`);
    if (r.accountState !== 'active') flags.push(`Gjendja: ${escapeHtml(r.accountState)}`);
    const text =
      `🔎 <b>Rreziku — ${escapeHtml(r.username)}</b>\n` +
      `Llogaria: ${Math.floor(r.accountAgeDays)} ditë · Bilanci: ${usd(r.balanceCents)}\n` +
      `Tërheqje më parë: ${r.priorWithdrawals} (${r.completedWithdrawals} të paguara, ${usd(r.priorWithdrawalsCents)})\n` +
      `\n💰 <b>Nga vijnë lekët</b> (gjithë kohën)\n` +
      `Depozituar: <b>${usd(f.depositedCents)}</b>\n` +
      `Fituar në lojë: <b>${usd(f.wonCents)}</b> · vënë bast: ${usd(-f.wageredCents)} → neto loja: <b>${usd(f.netGameCents)}</b>\n` +
      (f.transferInCents || f.transferOutCents ? `Nga shokë: +${usd(f.transferInCents)} / -${usd(-f.transferOutCents)}\n` : '') +
      (flags.length ? `\n${flags.join('\n')}` : '\n✅ Asnjë flamur i dukshëm rreziku.');
    const buttons: InlineButton[][] = [];
    if (this.deps.setAccountState) buttons.push([{ text: '🧊 Ngrij', callbackData: `us:freeze:${r.userId}` }, { text: '🚫 Blloko', callbackData: `us:ban:${r.userId}` }]);
    if (this.deps.findUser) buttons.push([{ text: '👤 Karta e plotë', callbackData: `us:show:${r.userId}` }]);
    await this.deps.bot.sendMessage(text, buttons.length ? { buttons } : {});
  }

  // ---- Tier-2: anti-cheat flags (/flags) -------------------------------------
  private async sendFlags(): Promise<void> {
    if (!this.deps.listFlags) return void (await this.deps.bot.sendMessage('Komanda /flags s’është aktive.'));
    const flags = await this.deps.listFlags(2, 10).catch(() => [] as FlagView[]);
    if (!flags.length) return void (await this.deps.bot.sendMessage('✅ S’ka sinjale anti-cheat (severity ≥ 2).'));
    await this.deps.bot.sendMessage(`🚩 <b>${flags.length}</b> sinjale anti-cheat (severity ≥ 2):`);
    for (const f of flags) {
      const buttons: InlineButton[][] = [];
      const row: InlineButton[] = [];
      if (this.deps.findUser) row.push({ text: '👤 Lojtari', callbackData: `us:show:${f.userId}` });
      if (this.deps.setAccountState) row.push({ text: '🚫 Blloko', callbackData: `us:ban:${f.userId}` });
      if (row.length) buttons.push(row);
      await this.deps.bot.sendMessage(this.renderFlag(f, await this.nameFor(f.userId)), buttons.length ? { buttons } : {});
    }
  }

  private renderFlag(f: FlagView, playerName: string): string {
    const sev = f.severity >= 3 ? '🔴 lartë' : f.severity >= 2 ? '🟠 mesatar' : '🟡 ulët';
    return (
      `🚩 <b>${escapeHtml(f.type)}</b> · ${sev}\n` +
      `${escapeHtml(f.detail)}\n` +
      (f.matchId ? `Ndeshja: <code>${escapeHtml(f.matchId)}</code>\n` : '') +
      `Lojtari: <b>${escapeHtml(playerName)}</b>`
    );
  }

  // ---- Tier-2: live game state (/live) ---------------------------------------
  private async sendLive(): Promise<void> {
    if (!this.deps.liveState) return void (await this.deps.bot.sendMessage('Komanda /live s’është aktive.'));
    const s = await this.deps.liveState().catch(() => null);
    if (!s) return void (await this.deps.bot.sendMessage('⚠️ S’u lexua dot gjendja e ndeshjeve.'));
    if (!s.matches) return void (await this.deps.bot.sendMessage('💤 Asnjë ndeshje aktive tani.'));
    const byType = s.byType.map((t) => `· ${escapeHtml(t.type)}: ${t.count} (${usd(t.potCents)})`).join('\n');
    await this.deps.bot.sendMessage(
      `🎮 <b>Ndeshje aktive: ${s.matches}</b>\n` +
      `Lekë në lojë tani: <b>${usd(s.potCents)}</b>` +
      (byType ? `\n${byType}` : ''),
    );
  }

  // ---- Tier-2: health (/health) ----------------------------------------------
  private async sendHealth(): Promise<void> {
    if (!this.deps.health) return void (await this.deps.bot.sendMessage('Komanda /health s’është aktive.'));
    const h = await this.deps.health().catch(() => null);
    if (!h) return void (await this.deps.bot.sendMessage('⚠️ S’u lexua dot gjendja e sistemit.'));
    const ok = (h.dbOk !== false) && h.reconcileOk && h.settlementFailures === 0;
    await this.deps.bot.sendMessage(
      `${ok ? '✅' : '🚨'} <b>Gjendja e sistemit</b>\n` +
      `DB: ${h.dbOk === null ? 'in-memory' : h.dbOk ? '✅ OK' : '🚨 POSHTË'}\n` +
      `Reconcile (ledger=bilanc): ${h.reconcileOk ? '✅ OK' : `🚨 ${h.mismatches} mospërputhje`}\n` +
      `Dështime settlement: ${h.settlementFailures === 0 ? '✅ 0' : `🚨 ${h.settlementFailures}`}\n` +
      `Ndeshje aktive: ${h.activeMatches} · Tërheqje në pritje: ${h.pendingWithdrawals}`,
    );
  }

  // ---- Tier-2: on-chain deposit funds awaiting a sweep (/deposits) ------------
  private async sendDeposits(): Promise<void> {
    if (!this.deps.depositFunds) return void (await this.deps.bot.sendMessage('Komanda /deposits s’është aktive.'));
    await this.deps.bot.sendMessage('🔎 Po lexoj adresat e depozitave on-chain… (pak sekonda)');
    const df = await this.deps.depositFunds().catch(() => null);
    if (!df) return void (await this.deps.bot.sendMessage('⚠️ S’u lexuan dot adresat e depozitave.'));
    if (df.totalCents === 0) return void (await this.deps.bot.sendMessage('💤 Asnjë USDT i paprekur te adresat e depozitave.'));
    const CAP = 15;
    const rows = df.funded.slice(0, CAP).map((f) => `· <code>${escapeHtml(f.address)}</code> — ${usd(f.cents)}`).join('\n');
    await this.deps.bot.sendMessage(
      `💰 <b>USDT i paprekur (për sweep)</b>\n` +
      `Total: <b>${usd(df.totalCents)}</b> · ${df.funded.length} adresa${df.partial ? ' (pjesërisht — shumë adresa/limit)' : ''}\n\n` +
      `${rows}${df.funded.length > CAP ? `\n… +${df.funded.length - CAP} të tjera` : ''}\n\n` +
      `<i>Mblidhi me sweep-app-in lokal (tools/sweep-app.bat). Gaz ~$1–2/adresë — bëj sweep kur ia vlen.</i>`,
    );
  }

  private async handleTicketTap(action: string | undefined, id: string, ref: MessageRef, cbId: string): Promise<void> {
    if (action === 'reply') {
      if (!this.deps.support) { await this.deps.bot.answerCallbackQuery(cbId); return; }
      const t = await this.deps.support.get(id).catch(() => null);
      if (!t) { await this.deps.bot.answerCallbackQuery(cbId, { text: 'Bileta nuk u gjet.' }); return; }
      this.pendingReply = { ticketId: id, subject: t.subject, at: Date.now() };
      await this.deps.bot.answerCallbackQuery(cbId, { text: 'Shkruaj përgjigjen…' });
      await this.deps.bot.sendMessage(`✍️ Shkruaj përgjigjen për biletën “${escapeHtml(t.subject)}”. Mesazhi yt i radhës i shkon lojtarit dhe e mbyll biletën.`);
      return;
    }
    if (action !== 'res') { await this.deps.bot.answerCallbackQuery(cbId); return; }
    await this.deps.bot.answerCallbackQuery(cbId, { text: 'Po e zgjidh…' });
    await this.resolveTicket(id, ref);
  }

  /** Reply to a ticket with free text: resolve it with the reply as the note + push the
   *  ACTUAL reply text to the player (they get the real answer, not a generic notice). */
  private async submitTicketReply(ticketId: string, reply: string): Promise<void> {
    if (!this.deps.support) { await this.deps.bot.sendMessage('Veprimi s’është aktiv.'); return; }
    const adminId = await this.deps.resolveAdminUserId();
    if (!adminId) { await this.deps.bot.sendMessage('⚠️ S’u gjet llogaria admin (vendos ADMIN_EMAIL te .env) — veprimi u ndal.'); return; }
    const t = await this.deps.support.resolve(ticketId, 'resolved', reply, Date.now()).catch(() => null);
    if (!t) { await this.deps.bot.sendMessage('⚠️ Bileta nuk u gjet (mund të jetë zgjidhur më parë).'); return; }
    // admin-5: do NOT silently swallow the audit write — a privileged action that
    // can't be audited must be flagged to the operator, not completed unrecorded.
    try {
      await this.deps.audit.record({ adminId, action: 'support_resolve', targetUserId: t.userId, detail: `${ticketId} reply (telegram): ${reply}` });
    } catch (err) {
      log.error('[telegram] support_resolve audit write FAILED (action applied, NOT audited):', err);
      await this.deps.bot.sendMessage('⚠️ Veprimi u krye, por SHËNIMI i auditit dështoi — kontrollo log-un.').catch(() => undefined);
    }
    let notified = '';
    if (this.deps.messagePlayer) {
      await this.deps.messagePlayer(t.userId, `Përgjigje: ${t.subject}`, reply).then(() => { notified = ' · lojtari u njoftua'; }).catch(() => {});
    }
    await this.deps.bot.sendMessage(`✅ <b>U përgjigje</b> · ${escapeHtml(t.subject)}${notified}`);
  }

  /** Buttons under a ticket message: free-text reply, or quick-resolve with a generic note. */
  private ticketButtons(id: string): InlineButton[][] {
    return [[{ text: '💬 Përgjigju', callbackData: `tk:reply:${id}` }, { text: '✅ Zgjidh', callbackData: `tk:res:${id}` }]];
  }

  /** Proactively alert the owner the moment a player opens a support ticket (called by the
   *  route on create). Best-effort: a Telegram failure never affects ticket creation. */
  async notifyNewTicket(ticket: SupportTicket): Promise<void> {
    if (!this.deps.support) return;
    await this.deps.bot.sendMessage(`🆕 <b>Biletë e re</b>\n${this.renderTicket(ticket, await this.nameFor(ticket.userId))}`, { buttons: this.ticketButtons(ticket.id) }).catch(() => undefined);
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
      // Tell the player their funds came back (best-effort).
      if (this.deps.messagePlayer) {
        await this.deps.messagePlayer(w.userId, 'Tërheqja u refuzua', `Tërheqja jote prej ${usd(w.amountCents)} u refuzua dhe fondet u kthyen në bilanc.`).catch(() => {});
      }
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
