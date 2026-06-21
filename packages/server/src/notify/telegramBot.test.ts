import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from './telegramBot.ts';

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(result: { ok: boolean; status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    return { ok: result.ok, status: result.status, json: async () => result.json ?? { ok: result.ok, result: { message_id: 7 } } };
  }) as never;
  return { fn, calls };
}

test('notifyInteractive sends an inline_keyboard built from callbackData', async () => {
  const { fn, calls } = fakeFetch({ ok: true, status: 200 });
  const bot = new TelegramBot('TOK', '42', fn);
  await bot.notifyInteractive('hi', [[{ text: 'A', callbackData: 'wd:ok:1' }, { text: 'B', callbackData: 'wd:no:1' }]]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/botTOK\/sendMessage$/);
  const markup = calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  assert.equal(markup.inline_keyboard[0]![0]!.callback_data, 'wd:ok:1');
  assert.equal(markup.inline_keyboard[0]![1]!.text, 'B');
  assert.equal(calls[0]!.body.chat_id, '42');
});

test('sendMessage returns the new message id from the response', async () => {
  const { fn } = fakeFetch({ ok: true, status: 200, json: { ok: true, result: { message_id: 123 } } });
  const bot = new TelegramBot('TOK', '42', fn);
  const res = await bot.sendMessage('hello');
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 123);
});

test('editMessageText always clears the keyboard when no buttons given', async () => {
  const { fn, calls } = fakeFetch({ ok: true, status: 200 });
  const bot = new TelegramBot('TOK', '42', fn);
  await bot.editMessageText('42', 50, 'done');
  const markup = calls[0]!.body.reply_markup as { inline_keyboard: unknown[] };
  assert.deepEqual(markup.inline_keyboard, []); // empty → buttons removed
  assert.equal(calls[0]!.body.message_id, 50);
});

test('setWebhook posts url + secret_token + allowed_updates', async () => {
  const { fn, calls } = fakeFetch({ ok: true, status: 200, json: { ok: true, result: true } });
  const bot = new TelegramBot('TOK', '42', fn);
  const ok = await bot.setWebhook('https://x.test/api/telegram/webhook', 's3cr3t');
  assert.equal(ok, true);
  assert.match(calls[0]!.url, /\/setWebhook$/);
  assert.equal(calls[0]!.body.url, 'https://x.test/api/telegram/webhook');
  assert.equal(calls[0]!.body.secret_token, 's3cr3t');
  assert.deepEqual(calls[0]!.body.allowed_updates, ['message', 'callback_query']);
});

test('a non-retryable 4xx returns ok:false and does not retry', async () => {
  let n = 0;
  const fn = (async () => { n += 1; return { ok: false, status: 400, json: async () => ({ ok: false }) }; }) as never;
  const bot = new TelegramBot('TOK', '42', fn);
  const res = await bot.sendMessage('x');
  assert.equal(res.ok, false);
  assert.equal(n, 1, 'a 400 is not retried');
});
