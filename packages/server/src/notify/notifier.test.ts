import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramNotifier, NullNotifier, createNotifier, escapeHtml } from './notifier.ts';

test('NullNotifier is a no-op and never throws', async () => {
  await new NullNotifier().notify('anything'); // must resolve, not throw
});

test('createNotifier picks Telegram only when BOTH token and chat id are set', () => {
  assert.equal(createNotifier({ telegramBotToken: null, telegramChatId: null }).name, 'null');
  assert.equal(createNotifier({ telegramBotToken: 't', telegramChatId: null }).name, 'null');
  assert.equal(createNotifier({ telegramBotToken: null, telegramChatId: 'c' }).name, 'null');
  assert.equal(createNotifier({ telegramBotToken: 't', telegramChatId: 'c' }).name, 'telegram');
});

test('TelegramNotifier posts to the bot sendMessage URL with chat id + text', async () => {
  let captured: { url: string; body: any } | null = null;
  const fetchFn = async (url: string, init: any) => { captured = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200 }; };
  await new TelegramNotifier('BOT123', 'CHAT9', fetchFn).notify('hello ops');
  assert.match(captured!.url, /api\.telegram\.org\/botBOT123\/sendMessage/);
  assert.equal(captured!.body.chat_id, 'CHAT9');
  assert.equal(captured!.body.text, 'hello ops');
  assert.equal(captured!.body.parse_mode, 'HTML');
});

test('TelegramNotifier swallows a fetch rejection (never throws)', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  await new TelegramNotifier('t', 'c', fetchFn).notify('x'); // must not throw
});

test('TelegramNotifier swallows a non-ok HTTP response', async () => {
  const fetchFn = async () => ({ ok: false, status: 403 });
  await new TelegramNotifier('t', 'c', fetchFn).notify('x'); // must not throw
});

test('escapeHtml neutralizes Telegram HTML special chars', () => {
  assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');
});
