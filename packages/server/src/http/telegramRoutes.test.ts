import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { telegramRoutes } from './telegramRoutes.ts';
import type { TelegramAdminBot, TgUpdate } from '../telegram/adminBot.ts';

const SECRET = 'webhook-secret-xyz';

async function build() {
  const seen: TgUpdate[] = [];
  const adminBot = { handleUpdate: async (u: TgUpdate) => { seen.push(u); } } as unknown as TelegramAdminBot;
  const app = Fastify();
  await telegramRoutes(app, { adminBot, webhookSecret: SECRET });
  await app.ready();
  return { app, seen };
}

test('rejects an update with a missing secret header (401, not dispatched)', async () => {
  const { app, seen } = await build();
  const res = await app.inject({ method: 'POST', url: '/api/telegram/webhook', payload: { message: { message_id: 1, chat: { id: 1 }, text: '/help' } } });
  assert.equal(res.statusCode, 401);
  assert.equal(seen.length, 0);
  await app.close();
});

test('rejects an update with a wrong secret (401)', async () => {
  const { app, seen } = await build();
  const res = await app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'nope' }, payload: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(seen.length, 0);
  await app.close();
});

test('accepts + dispatches an update with the correct secret', async () => {
  const { app, seen } = await build();
  const update = { message: { message_id: 9, chat: { id: 42 }, text: '/stats' } };
  const res = await app.inject({ method: 'POST', url: '/api/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': SECRET }, payload: update });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.message!.text, '/stats');
  await app.close();
});
