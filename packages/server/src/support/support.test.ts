import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHttpApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { InMemoryAdminAudit } from '../auth/adminAudit.ts';
import { InMemorySupportRepository } from './supportRepository.ts';

test('InMemorySupportRepository: create, list newest-first, resolve', async () => {
  const repo = new InMemorySupportRepository();
  const a = await repo.create({ userId: 'u1', category: 'match', subject: 'Dispute m1', message: 'hand looked wrong', matchId: 'm1' });
  await new Promise((r) => setTimeout(r, 2));
  const b = await repo.create({ userId: 'u1', category: 'payment', subject: 'Deposit stuck', message: 'no credit' });
  await repo.create({ userId: 'u2', category: 'other', subject: 'hi', message: 'hello there' });

  const mine = await repo.listByUser('u1');
  assert.equal(mine.length, 2);
  assert.equal(mine[0]!.id, b.id); // newest first
  assert.equal(a.status, 'open');
  assert.equal(a.matchId, 'm1');

  const resolved = await repo.resolve(a.id, 'resolved', 'refunded the hand', 123);
  assert.equal(resolved!.status, 'resolved');
  assert.equal(resolved!.adminNote, 'refunded the hand');
  assert.equal(resolved!.resolvedAt, 123);
  assert.equal((await repo.list(50)).length, 3);
});

async function build() {
  const repo = new InMemoryUserRepository();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'r' });
  const auth = new AuthService(repo, tokens);
  const support = new InMemorySupportRepository();
  const adminAudit = new InMemoryAdminAudit();
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  const app = await buildHttpApp({ auth, config, support, adminAudit });
  const reg = await auth.register({ username: 'player', email: 'p@x.com', password: 'password123' });
  const admin = await repo.create({ username: 'admin', email: 'a@x.com', passwordHash: 'h', role: 'admin' });
  const adminToken = tokens.issuePair(admin.id, admin.username).accessToken;
  return { app, support, adminAudit, userToken: reg.tokens.accessToken, userId: reg.user.id, adminToken };
}
const authH = (t: string) => ({ authorization: `Bearer ${t}` });

test('support flow: player opens a ticket + sees it; admin resolves it (audited); non-admin is blocked', async () => {
  const { app, adminAudit, userToken, userId, adminToken } = await build();
  try {
    // Validation rejects a too-short message.
    const bad = await app.inject({ method: 'POST', url: '/api/support/tickets', headers: authH(userToken), payload: { category: 'match', subject: 'hi', message: 'x' } });
    assert.equal(bad.statusCode, 400);

    const created = await app.inject({ method: 'POST', url: '/api/support/tickets', headers: authH(userToken), payload: { category: 'match', subject: 'Dispute in m1', message: 'I think the deal was wrong', matchId: 'm1' } });
    assert.equal(created.statusCode, 201);
    const id = created.json().ticket.id as string;

    const mine = await app.inject({ method: 'GET', url: '/api/support/tickets', headers: authH(userToken) });
    assert.equal(mine.json().tickets.length, 1);
    assert.equal(mine.json().tickets[0].status, 'open');

    // A non-admin can't see the admin triage list.
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/support', headers: authH(userToken) })).statusCode, 403);

    // Admin resolves the ticket → audited.
    const res = await app.inject({ method: 'POST', url: `/api/admin/support/${id}/resolve`, headers: authH(adminToken), payload: { status: 'resolved', adminNote: 'verified via provably-fair replay; no error' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ticket.status, 'resolved');

    const actions = await adminAudit.list();
    assert.ok(actions.some((a) => a.action === 'support_resolve' && a.targetUserId === userId));
  } finally {
    await app.close();
  }
});
