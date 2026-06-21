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
  const deps: AdminBotDeps = {
    bot: bot as never,
    authorizedChatId: CHAT,
    resolveAdminUserId: async () => 'admin1',
    withdrawals: wd as never,
    payout: null,
    audit: { record: async (a) => { audit.push({ action: a.action, targetUserId: a.targetUserId ?? null, amountCents: a.amountCents ?? null }); }, list: async () => [] } as never,
    wallet: { getBalance: async () => 100000 },
    listUsers: async () => [{ balanceCents: 2000 }, { balanceCents: 3000 }],
    largeWithdrawalCents: 20000,
    ...over,
  };
  return { deps, calls, audit, wd };
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
