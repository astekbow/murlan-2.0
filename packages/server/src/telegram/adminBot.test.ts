import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdminBot, type AdminBotDeps } from './adminBot.ts';
import { WithdrawalError, type WithdrawalRecord } from '../money/withdrawals.ts';

const CHAT = '12345';

function pendingRec(over: Partial<WithdrawalRecord> = {}): WithdrawalRecord {
  return {
    id: 'w1', userId: 'u1', amountCents: 5000, destination: 'TGoodAddress0000000000000000000000',
    status: 'pending', createdAt: 0, resolvedAt: null, providerRef: null, network: null, txHash: null,
    resolvedByAdminId: null, failureReason: null, ...over,
  } as WithdrawalRecord;
}

/** Records every Bot API call so assertions can inspect them. */
function fakeBot() {
  const calls = { sent: [] as Array<{ text: string; buttons?: unknown }>, edits: [] as Array<{ messageId: number; text: string; buttons?: unknown }>, answers: [] as Array<{ id: string; text?: string }> };
  const bot = {
    async sendMessage(text: string, opts: { buttons?: unknown } = {}) { calls.sent.push({ text, buttons: opts.buttons }); return { ok: true, messageId: 999 }; },
    async editMessageText(_chatId: unknown, messageId: number, text: string, opts: { buttons?: unknown } = {}) { calls.edits.push({ messageId, text, buttons: opts.buttons }); return true; },
    async answerCallbackQuery(id: string, opts: { text?: string } = {}) { calls.answers.push({ id, text: opts.text }); return true; },
  };
  return { bot, calls };
}

function makeDeps(over: Partial<AdminBotDeps> & { rec?: WithdrawalRecord } = {}) {
  const { bot, calls } = fakeBot();
  const audit: Array<{ action: string; targetUserId: string | null; amountCents: number | null }> = [];
  const rec = over.rec ?? pendingRec();
  const wd = {
    find: async (_id: string) => rec,
    payoutNow: async (_id: string, _p: unknown, _o: unknown) => ({ ...rec, status: 'completed', providerRef: 'ref-xyz' }),
    reject: async (_id: string, _a: unknown) => ({ ...rec, status: 'rejected' }),
    listPending: async () => [rec],
  };
  // Phase 2 fakes
  const user = { id: 'u9', username: 'lojtari', email: 'l@x.com', role: 'user', balanceCents: 1500, kycStatus: 'none', accountState: 'active', accountStateReason: null as string | null, accountStateUntil: null as number | null, createdAt: 0 };
  const kicked: string[] = [];
  const stateCalls: Array<{ userId: string; state: string; until: number | null }> = [];
  const resolved: string[] = [];
  const tickets = [{ id: 't1', userId: 'u9', category: 'payment', subject: 'S’më erdhi depozita', message: 'help', status: 'open', matchId: null, adminNote: null, createdAt: 0, resolvedAt: null }];
  const adjustCalls: Array<{ userId: string; deltaCents: number; reason: string }> = [];
  const voidCalls: Array<{ roomId: string; reason: string }> = [];
  const tCreate: Array<{ name: string; buyInCents: number; capacity: number }> = [];
  const tCancel: string[] = [];
  const msgCalls: Array<{ userId: string; title: string; body: string }> = [];
  const riskCalls: Array<{ userId: string; anchorMs?: number }> = [];
  const deps: AdminBotDeps = {
    bot: bot as never,
    authorizedChatId: CHAT,
    resolveAdminUserId: async () => 'admin1',
    withdrawals: wd as never,
    payout: null,
    audit: { record: async (a: { action: string; targetUserId?: string | null; amountCents?: number | null }) => { audit.push({ action: a.action, targetUserId: a.targetUserId ?? null, amountCents: a.amountCents ?? null }); }, list: async () => [] } as never,
    wallet: { getBalance: async () => 100000 },
    listUsers: async () => [{ balanceCents: 2000 }, { balanceCents: 3000 }],
    largeWithdrawalCents: 20000,
    findUser: async (q: string) => (q === user.id || q === user.email || q === user.username ? { ...user } : null),
    setAccountState: async (userId: string, patch) => { stateCalls.push({ userId, state: patch.state, until: patch.until }); user.accountState = patch.state; user.accountStateReason = patch.reason; user.accountStateUntil = patch.until; return true; },
    kickUser: (userId: string) => { kicked.push(userId); },
    usernameFor: async (id: string) => ({ u1: 'Beni', u9: 'Lira' } as Record<string, string>)[id] ?? null,
    support: { list: async () => tickets, get: async () => tickets[0], resolve: async (id: string) => { resolved.push(id); return { ...tickets[0]!, status: 'resolved' }; }, create: async () => tickets[0], listByUser: async () => tickets } as never,
    digest: async () => ({ players: 12, newSignups24h: 3, rake24hCents: 4200, pendingWithdrawals: 1, pendingWithdrawalsCents: 5000, liabilitiesCents: 9000 }),
    // Phase 3 fakes
    adminAdjust: async (userId: string, deltaCents: number, reason: string) => { adjustCalls.push({ userId, deltaCents, reason }); return { ok: true as const, balanceCents: 1500 + deltaCents }; },
    voidMatch: async (roomId: string, meta: { adminId: string; reason: string }) => { voidCalls.push({ roomId, reason: meta.reason }); return { ok: true as const, matchId: 'm1', refunded: true }; },
    tournamentCreate: async (name: string, buyInCents: number, capacity: number) => { tCreate.push({ name, buyInCents, capacity }); return { ok: true as const, id: 'trn1', name }; },
    tournamentCancel: async (id: string) => { tCancel.push(id); return { ok: true as const }; },
    // Tier-2 fakes
    userRisk: async (userId: string, anchorMs?: number) => { riskCalls.push({ userId, anchorMs }); return { userId, username: 'lojtari', accountAgeDays: 0.5, kycStatus: 'none', accountState: 'active', balanceCents: 1500, priorWithdrawals: 2, completedWithdrawals: 1, priorWithdrawalsCents: 800, sameDayDepositWithdraw: true, funds: { depositedCents: 2000, wonCents: 500, wageredCents: -700, transferInCents: 0, transferOutCents: 0, netGameCents: -200 } }; },
    listFlags: async (_min: number, _limit: number) => [{ id: 'f1', userId: 'u9', type: 'chip_dump', severity: 3, detail: 'humbi 3 herë radhazi te i njëjti', matchId: 'm1', createdAt: 0 }],
    messagePlayer: async (userId: string, title: string, body: string) => { msgCalls.push({ userId, title, body }); },
    liveState: async () => ({ matches: 2, potCents: 3000, byType: [{ type: 'quick', count: 2, potCents: 3000 }] }),
    health: async () => ({ dbOk: true, reconcileOk: true, mismatches: 0, settlementFailures: 0, activeMatches: 2, pendingWithdrawals: 1 }),
    depositFunds: async () => ({ totalCents: 1234, funded: [{ address: 'TAaa', cents: 1000 }, { address: 'TBbb', cents: 234 }], partial: false }),
    ...over,
  };
  return { deps, calls, audit, wd, user, kicked, stateCalls, resolved, tickets, adjustCalls, voidCalls, tCreate, tCancel, msgCalls, riskCalls };
}

test('ignores messages from an unauthorized chat', async () => {
  const { deps, calls } = makeDeps();
  const botz = new TelegramAdminBot(deps);
  await botz.handleUpdate({ message: { message_id: 1, chat: { id: 'evil' }, text: '/stats' } });
  assert.equal(calls.sent.length, 0, 'no reply to a stranger');
});

// telegram-2/3: a message whose SENDER (from.id) is not the owner is rejected EVEN if it
// arrives in the authorized chat (the "chat.id OR from.id" hole — a group member posting
// in a group whose id was configured — must not pass).
test('telegram-2/3: a non-owner SENDER is rejected even inside the authorized chat', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 9, chat: { id: CHAT }, from: { id: 'evil' }, text: '/stats' } });
  assert.equal(calls.sent.length, 0, 'a stranger sender gets no reply, even in the owner chat');
});

test('telegram-2/3: the owner SENDER (from.id) is authorized', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 10, chat: { id: CHAT }, from: { id: CHAT }, text: '/help' } });
  assert.equal(calls.sent.length, 1);
});

test('/help replies with the command list', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 1, chat: { id: CHAT }, text: '/help' } });
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0]!.text, /Murlan/);
});

test('approve tap on a SMALL withdrawal pays out + audits + edits to ✅', async () => {
  const { deps, calls, audit } = makeDeps({ rec: pendingRec({ amountCents: 5000 }) });
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'cb1', from: { id: CHAT }, message: { message_id: 50, chat: { id: CHAT } }, data: 'wd:ok:w1' },
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, 'withdrawal_approve');
  assert.equal(audit[0]!.amountCents, 5000);
  const edit = calls.edits.at(-1)!;
  assert.match(edit.text, /Aprovuar/);
  assert.deepEqual(edit.buttons, []); // buttons cleared on resolve
});

test('approve tap on a LARGE withdrawal asks to confirm (no payout yet)', async () => {
  const { deps, calls, audit } = makeDeps({ rec: pendingRec({ amountCents: 50000 }) });
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'cb2', from: { id: CHAT }, message: { message_id: 51, chat: { id: CHAT } }, data: 'wd:ok:w1' },
  });
  assert.equal(audit.length, 0, 'must NOT pay out before the confirm tap');
  const edit = calls.edits.at(-1)!;
  assert.match(edit.text, /Konfirmo/);
  const rows = edit.buttons as Array<Array<{ callbackData: string }>>;
  assert.equal(rows[0]![0]!.callbackData, 'wd:cfm:w1');
  assert.equal(rows[0]![1]!.callbackData, 'wd:x:w1');
});

test('confirm tap on a large withdrawal pays out', async () => {
  const { deps, audit } = makeDeps({ rec: pendingRec({ amountCents: 50000 }) });
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'cb3', from: { id: CHAT }, message: { message_id: 52, chat: { id: CHAT } }, data: 'wd:cfm:w1' },
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, 'withdrawal_approve');
});

test('reject tap refunds + audits withdrawal_reject', async () => {
  const { deps, calls, audit } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'cb4', from: { id: CHAT }, message: { message_id: 53, chat: { id: CHAT } }, data: 'wd:no:w1' },
  });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.action, 'withdrawal_reject');
  assert.match(calls.edits.at(-1)!.text, /Refuzuar/);
});

test('an unauthorized callback is answered but never acts', async () => {
  const { deps, calls, audit } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'cb5', from: { id: 'evil' }, message: { message_id: 54, chat: { id: 'evil' } }, data: 'wd:ok:w1' },
  });
  assert.equal(audit.length, 0);
  assert.equal(calls.edits.length, 0);
  assert.equal(calls.answers.length, 1);
  assert.match(calls.answers[0]!.text ?? '', /paautorizuar/);
});

test('approve fails gracefully when the row is no longer pending', async () => {
  const { deps, calls, audit } = makeDeps({ rec: pendingRec({ amountCents: 5000 }) });
  // payoutNow throws not_pending (already resolved by a racing panel action).
  (deps.withdrawals as unknown as { payoutNow: () => Promise<never> }).payoutNow = async () => { throw new WithdrawalError('not_pending', 'Tërheqja nuk është në pritje.'); };
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'cb6', from: { id: CHAT }, message: { message_id: 55, chat: { id: CHAT } }, data: 'wd:ok:w1' },
  });
  assert.equal(audit.length, 0);
  assert.match(calls.edits.at(-1)!.text, /pritje/);
});

test('/stats reports liabilities + pending count', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 2, chat: { id: CHAT }, text: '/stats' } });
  const text = calls.sent.at(-1)!.text;
  assert.match(text, /Statistika/);
  assert.match(text, /\$50\.00/); // liabilities 2000+3000
});

// ---- Phase 2 ----

test('/user shows the account + state-change buttons', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 3, chat: { id: CHAT }, text: '/user lojtari' } });
  const sent = calls.sent.at(-1)!;
  assert.match(sent.text, /lojtari/);
  const rows = sent.buttons as Array<Array<{ callbackData: string }>>;
  const cbs = rows.flat().map((b) => b.callbackData);
  assert.ok(cbs.includes('us:freeze:u9'));
  assert.ok(cbs.includes('us:ban:u9'));
});

test('ban tap sets state, kicks sockets, and audits account_state_set', async () => {
  const { deps, audit, kicked, stateCalls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 60, chat: { id: CHAT } }, data: 'us:ban:u9' },
  });
  assert.equal(stateCalls.at(-1)!.state, 'banned');
  assert.deepEqual(kicked, ['u9']);
  assert.equal(audit.at(-1)!.action, 'account_state_set');
});

test('suspend tap carries a 7-day expiry', async () => {
  const { deps, stateCalls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 61, chat: { id: CHAT } }, data: 'us:susp:u9' },
  });
  const call = stateCalls.at(-1)!;
  assert.equal(call.state, 'suspended');
  assert.ok(call.until && call.until > Date.now() + 6 * 24 * 3600 * 1000, 'expiry ~7 days out');
});

test('/tickets lists open tickets with Reply + Resolve buttons', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 4, chat: { id: CHAT }, text: '/tickets' } });
  const sent = calls.sent.at(-1)!;
  const rows = sent.buttons as Array<Array<{ callbackData: string }>>;
  const cbs = rows[0]!.map((b) => b.callbackData);
  assert.ok(cbs.includes('tk:reply:t1'), 'has a Reply button');
  assert.ok(cbs.includes('tk:res:t1'), 'has a Resolve button');
  // Shows the player's USERNAME, not the raw userId.
  assert.match(sent.text, /Lira/, 'ticket shows the username');
  assert.ok(!sent.text.includes('u9'), 'ticket does NOT show the raw userId');
});

test('reply tap → next message is sent to the player as the reply + resolves the ticket', async () => {
  const { deps, audit, resolved, msgCalls } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  // Owner taps "Përgjigju" on ticket t1 → bot stages a pending reply + prompts.
  await bot.handleUpdate({ callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 70, chat: { id: CHAT } }, data: 'tk:reply:t1' } });
  // Owner's next plain message IS the reply text.
  await bot.handleUpdate({ message: { message_id: 71, chat: { id: CHAT }, text: 'I kemi kthyer fondet, kontrollo bilancin.' } });
  assert.ok(resolved.includes('t1'), 'ticket resolved');
  assert.ok(msgCalls.some((m) => m.body === 'I kemi kthyer fondet, kontrollo bilancin.'), 'player received the ACTUAL reply text');
  assert.equal(audit.at(-1)!.action, 'support_resolve', 'audited');
});

test('a command cancels a staged ticket reply (not treated as the reply)', async () => {
  const { deps, resolved } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 72, chat: { id: CHAT } }, data: 'tk:reply:t1' } });
  await bot.handleUpdate({ message: { message_id: 73, chat: { id: CHAT }, text: '/stats' } }); // a command bails out
  assert.equal(resolved.length, 0, 'no ticket resolved — the command cancelled the staged reply');
});

test('resolve tap resolves the ticket + audits support_resolve', async () => {
  const { deps, audit, resolved } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 62, chat: { id: CHAT } }, data: 'tk:res:t1' },
  });
  assert.deepEqual(resolved, ['t1']);
  assert.equal(audit.at(-1)!.action, 'support_resolve');
});

test('/digest renders the 24h numbers', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).sendDigest();
  const text = calls.sent.at(-1)!.text;
  assert.match(text, /Përmbledhja/);
  assert.match(text, /\+3 të rinj/);
  assert.match(text, /\$42\.00/); // rake 4200
});

test('Phase-2 commands degrade gracefully when their deps are absent', async () => {
  const { deps, calls } = makeDeps({ findUser: undefined, support: undefined, digest: undefined });
  const botz = new TelegramAdminBot(deps);
  // help must not advertise the disabled commands
  await botz.handleUpdate({ message: { message_id: 5, chat: { id: CHAT }, text: '/help' } });
  assert.doesNotMatch(calls.sent.at(-1)!.text, /\/user/);
  // /user with no findUser → a friendly "not active" (no throw)
  await botz.handleUpdate({ message: { message_id: 6, chat: { id: CHAT }, text: '/user x' } });
  assert.match(calls.sent.at(-1)!.text, /s’është aktive/);
});

// ---- Phase 3 ----

/** Pull the `pa:ok:*` / `pa:x:*` callback from the last confirm message. */
function confirmCbs(calls: { sent: Array<{ buttons?: unknown }> }): { ok: string; cancel: string } {
  const rows = calls.sent.at(-1)!.buttons as Array<Array<{ callbackData: string }>>;
  return { ok: rows[0]![0]!.callbackData, cancel: rows[0]![1]!.callbackData };
}
const cbq = (data: string, mid: number) => ({ callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: mid, chat: { id: CHAT } }, data } });

test('/credit stages a confirm, then executes the adjust + audits on confirm', async () => {
  const { deps, calls, audit, adjustCalls } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ message: { message_id: 7, chat: { id: CHAT }, text: '/credit lojtari 5 goodwill' } });
  assert.equal(adjustCalls.length, 0, 'no adjust before the confirm tap');
  const { ok } = confirmCbs(calls);
  assert.match(ok, /^pa:ok:/);
  await bot.handleUpdate(cbq(ok, 70));
  assert.equal(adjustCalls.length, 1);
  assert.equal(adjustCalls[0]!.deltaCents, 500);
  assert.equal(audit.at(-1)!.action, 'balance_adjust');
  assert.equal(audit.at(-1)!.amountCents, 500);
});

test('/debit stages a NEGATIVE adjust', async () => {
  const { deps, calls, adjustCalls } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ message: { message_id: 8, chat: { id: CHAT }, text: '/debit lojtari 2.50 penalty' } });
  await bot.handleUpdate(cbq(confirmCbs(calls).ok, 80));
  assert.equal(adjustCalls.at(-1)!.deltaCents, -250);
});

test('cancel tap on a staged adjust does NOT execute it', async () => {
  const { deps, calls, adjustCalls } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ message: { message_id: 9, chat: { id: CHAT }, text: '/credit lojtari 5 x' } });
  await bot.handleUpdate(cbq(confirmCbs(calls).cancel, 90));
  assert.equal(adjustCalls.length, 0);
  assert.match(calls.edits.at(-1)!.text, /Anuluar/);
});

test('a double confirm tap executes at most once', async () => {
  const { deps, calls, adjustCalls } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ message: { message_id: 10, chat: { id: CHAT }, text: '/credit lojtari 5 x' } });
  const { ok } = confirmCbs(calls);
  await bot.handleUpdate(cbq(ok, 100));
  await bot.handleUpdate(cbq(ok, 100));
  assert.equal(adjustCalls.length, 1);
});

test('a debit that overdraws shows an insufficient-funds message', async () => {
  const { deps, calls } = makeDeps({ adminAdjust: async () => ({ ok: false, reason: 'insufficient_funds' }) });
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ message: { message_id: 11, chat: { id: CHAT }, text: '/debit lojtari 5 x' } });
  await bot.handleUpdate(cbq(confirmCbs(calls).ok, 110));
  assert.match(calls.edits.at(-1)!.text, /pamjaftueshëm/);
});

test('/void stages a confirm then voids the match + audits match_void', async () => {
  const { deps, calls, audit, voidCalls } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ message: { message_id: 12, chat: { id: CHAT }, text: '/void room42 collusion suspected' } });
  assert.equal(voidCalls.length, 0);
  await bot.handleUpdate(cbq(confirmCbs(calls).ok, 120));
  assert.equal(voidCalls.at(-1)!.roomId, 'room42');
  assert.equal(voidCalls.at(-1)!.reason, 'collusion suspected');
  assert.equal(audit.at(-1)!.action, 'match_void');
});

test('/tournament new creates + audits tournament_create', async () => {
  const { deps, calls, audit, tCreate } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 13, chat: { id: CHAT }, text: '/tournament new 5 8' } });
  assert.equal(tCreate.at(-1)!.buyInCents, 500);
  assert.equal(tCreate.at(-1)!.capacity, 8);
  assert.equal(audit.at(-1)!.action, 'tournament_create');
  assert.match(calls.sent.at(-1)!.text, /krijuar/);
});

test('/tournament new rejects an invalid capacity', async () => {
  const { deps, calls, tCreate } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 14, chat: { id: CHAT }, text: '/tournament new 5 5' } });
  assert.equal(tCreate.length, 0);
  assert.match(calls.sent.at(-1)!.text, /2, 4 ose 8/);
});

test('/tournament cancel cancels + audits tournament_cancel', async () => {
  const { deps, audit, tCancel } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 15, chat: { id: CHAT }, text: '/tournament cancel trn1' } });
  assert.deepEqual(tCancel, ['trn1']);
  assert.equal(audit.at(-1)!.action, 'tournament_cancel');
});

test('an unauthorized confirm tap never executes the staged action', async () => {
  const { deps, calls, adjustCalls } = makeDeps();
  const bot = new TelegramAdminBot(deps);
  await bot.handleUpdate({ message: { message_id: 16, chat: { id: CHAT }, text: '/credit lojtari 5 x' } });
  const { ok } = confirmCbs(calls);
  await bot.handleUpdate({ callback_query: { id: 'c', from: { id: 'evil' }, message: { message_id: 160, chat: { id: 'evil' } }, data: ok } });
  assert.equal(adjustCalls.length, 0);
});

// ---- Tier-2 ----

test('/withdrawals rows carry a 👤 Rreziku button when userRisk is wired', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 17, chat: { id: CHAT }, text: '/withdrawals' } });
  const rows = calls.sent.at(-1)!.buttons as Array<Array<{ callbackData: string }>>;
  const cbs = rows.flat().map((b) => b.callbackData);
  assert.ok(cbs.some((c) => c.startsWith('wd:risk:')));
});

test('the Rreziku tap shows the risk card with the same-day flag + actions', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 170, chat: { id: CHAT } }, data: 'wd:risk:w1' },
  });
  const sent = calls.sent.at(-1)!;
  assert.match(sent.text, /Rreziku/);
  assert.match(sent.text, /njëjtën ditë/); // same-day deposit→withdraw warning
  const cbs = (sent.buttons as Array<Array<{ callbackData: string }>>).flat().map((b) => b.callbackData);
  assert.ok(cbs.includes('us:ban:u1'));
});

test('/flags lists high-severity flags with Lojtari + Blloko buttons', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 18, chat: { id: CHAT }, text: '/flags' } });
  const sent = calls.sent.at(-1)!;
  assert.match(sent.text, /chip_dump/);
  const cbs = (sent.buttons as Array<Array<{ callbackData: string }>>).flat().map((b) => b.callbackData);
  assert.ok(cbs.includes('us:show:u9'));
  assert.ok(cbs.includes('us:ban:u9'));
});

test('us:show tap opens the full user card', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 180, chat: { id: CHAT } }, data: 'us:show:u9' },
  });
  assert.match(calls.sent.at(-1)!.text, /lojtari/);
});

test('resolving a ticket notifies the player', async () => {
  const { deps, msgCalls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 190, chat: { id: CHAT } }, data: 'tk:res:t1' },
  });
  assert.equal(msgCalls.at(-1)!.userId, 'u9');
  assert.match(msgCalls.at(-1)!.title, /Mbështetje/);
});

test('rejecting a withdrawal notifies the player their funds returned', async () => {
  const { deps, msgCalls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 200, chat: { id: CHAT } }, data: 'wd:no:w1' },
  });
  assert.equal(msgCalls.at(-1)!.userId, 'u1');
  assert.match(msgCalls.at(-1)!.body, /kthye/);
});

test('/live shows active matches + pot at risk', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 21, chat: { id: CHAT }, text: '/live' } });
  const text = calls.sent.at(-1)!.text;
  assert.match(text, /Ndeshje aktive: 2/);
  assert.match(text, /\$30\.00/); // pot 3000
});

test('/health reports OK when everything is green', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 22, chat: { id: CHAT }, text: '/health' } });
  const text = calls.sent.at(-1)!.text;
  assert.match(text, /Gjendja e sistemit/);
  assert.match(text, /✅ OK/);
});

test('/deposits shows the on-chain total + funded addresses', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 24, chat: { id: CHAT }, text: '/deposits' } });
  const text = calls.sent.at(-1)!.text;
  assert.match(text, /paprekur/);
  assert.match(text, /\$12\.34/); // total 1234 cents
  assert.match(text, /TAaa/);     // top funded address listed
});

test('/deposits reports nothing to sweep when total is 0', async () => {
  const { deps, calls } = makeDeps({ depositFunds: async () => ({ totalCents: 0, funded: [], partial: false }) });
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 25, chat: { id: CHAT }, text: '/deposits' } });
  assert.match(calls.sent.at(-1)!.text, /Asnjë USDT/);
});

test('/health flags trouble when reconcile mismatches exist', async () => {
  const { deps, calls } = makeDeps({ health: async () => ({ dbOk: true, reconcileOk: false, mismatches: 2, settlementFailures: 1, activeMatches: 0, pendingWithdrawals: 0 }) });
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 23, chat: { id: CHAT }, text: '/health' } });
  const text = calls.sent.at(-1)!.text;
  assert.match(text, /🚨/);
  assert.match(text, /2 mospërputhje/);
});

// ---- review fixes ----

test('the risk check is anchored on the withdrawal’s own createdAt, not "today"', async () => {
  const { deps, riskCalls } = makeDeps({ rec: pendingRec({ createdAt: 1_700_000_000_000 }) });
  await new TelegramAdminBot(deps).handleUpdate({
    callback_query: { id: 'c', from: { id: CHAT }, message: { message_id: 210, chat: { id: CHAT } }, data: 'wd:risk:w1' },
  });
  assert.equal(riskCalls.at(-1)!.anchorMs, 1_700_000_000_000);
});

test('owner tap on a message-less callback (>48h old alert) is authorized via from.id', async () => {
  const { deps, calls } = makeDeps();
  // No `message` on the callback → only from.id is available; the owner must still act.
  await new TelegramAdminBot(deps).handleUpdate({ callback_query: { id: 'c', from: { id: CHAT }, data: 'wd:risk:w1' } });
  assert.match(calls.sent.at(-1)!.text, /Rreziku/); // acted (sent the risk card)
});

test('a message-less callback from a stranger is still rejected', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ callback_query: { id: 'c', from: { id: 'evil' }, data: 'wd:risk:w1' } });
  assert.equal(calls.sent.length, 0);
  assert.match(calls.answers.at(-1)!.text ?? '', /paautorizuar/);
});
