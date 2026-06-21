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
    support: { list: async () => tickets, get: async () => tickets[0], resolve: async (id: string) => { resolved.push(id); return { ...tickets[0]!, status: 'resolved' }; }, create: async () => tickets[0], listByUser: async () => tickets } as never,
    digest: async () => ({ players: 12, newSignups24h: 3, rake24hCents: 4200, pendingWithdrawals: 1, pendingWithdrawalsCents: 5000, liabilitiesCents: 9000 }),
    ...over,
  };
  return { deps, calls, audit, wd, user, kicked, stateCalls, resolved, tickets };
}

test('ignores messages from an unauthorized chat', async () => {
  const { deps, calls } = makeDeps();
  const botz = new TelegramAdminBot(deps);
  await botz.handleUpdate({ message: { message_id: 1, chat: { id: 'evil' }, text: '/stats' } });
  assert.equal(calls.sent.length, 0, 'no reply to a stranger');
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

test('/tickets lists open tickets with a Resolve button', async () => {
  const { deps, calls } = makeDeps();
  await new TelegramAdminBot(deps).handleUpdate({ message: { message_id: 4, chat: { id: CHAT }, text: '/tickets' } });
  const sent = calls.sent.at(-1)!;
  const rows = sent.buttons as Array<Array<{ callbackData: string }>>;
  assert.equal(rows[0]![0]!.callbackData, 'tk:res:t1');
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
