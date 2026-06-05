import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository } from './userRepository.ts';
import { AccountStateService } from './accountStateService.ts';
import { TokenService } from './tokens.ts';
import { AuthService, AuthError } from './authService.ts';

// ---------- Pure service ----------------------------------------------------

test('AccountStateService.checkLogin blocks banned + active suspension, allows the rest', () => {
  const svc = new AccountStateService(() => 1_000);
  assert.equal(svc.checkLogin({ state: 'active', reason: null, until: null }).allowed, true);
  assert.equal(svc.checkLogin({ state: 'frozen', reason: null, until: null }).allowed, true); // frozen may still log in
  assert.equal(svc.checkLogin({ state: 'banned', reason: null, until: null }).allowed, false);
  assert.equal(svc.checkLogin({ state: 'suspended', reason: null, until: 2_000 }).allowed, false); // still within window
});

test('AccountStateService: an expired suspension resolves back to active', () => {
  const svc = new AccountStateService(() => 5_000);
  const expired = { state: 'suspended' as const, reason: null, until: 2_000 };
  assert.equal(svc.effective(expired), 'active');
  assert.equal(svc.checkLogin(expired).allowed, true);
  assert.equal(svc.checkRealMoney(expired).allowed, true);
});

test('AccountStateService.checkRealMoney blocks frozen (and banned/suspended)', () => {
  const svc = new AccountStateService(() => 1_000);
  assert.equal(svc.checkRealMoney({ state: 'active', reason: null, until: null }).allowed, true);
  assert.equal(svc.checkRealMoney({ state: 'frozen', reason: null, until: null }).allowed, false);
  assert.equal(svc.checkRealMoney({ state: 'banned', reason: null, until: null }).allowed, false);
});

// ---------- AuthService integration -----------------------------------------

function makeService() {
  const repo = new InMemoryUserRepository();
  const tokens = new TokenService({ accessSecret: 'a-secret', refreshSecret: 'r-secret', accessTtl: '15m', refreshTtl: '7d' });
  return { repo, auth: new AuthService(repo, tokens) };
}
const creds = { username: 'banuser', email: 'ban@example.com', password: 'supersecret1' };

test('a banned account cannot log in, and banning revokes existing sessions', async () => {
  const { repo, auth } = makeService();
  const reg = await auth.register(creds);

  await auth.setAccountState(reg.user.id, { state: 'banned', reason: 'collusion' });
  // Existing refresh token is now invalid (tokenVersion bumped).
  await assert.rejects(() => auth.refresh(reg.tokens.refreshToken), AuthError);
  // Fresh login is blocked too.
  await assert.rejects(() => auth.login({ email: creds.email, password: creds.password }), (e) => e instanceof AuthError && e.code === 'account_banned');
  assert.equal((await repo.findById(reg.user.id))!.accountState, 'banned');
});

test('a frozen account CAN log in but is blocked from staked play / deposits', async () => {
  const { auth } = makeService();
  const reg = await auth.register({ ...creds, username: 'frozenu', email: 'frozen@example.com' });
  await auth.setAccountState(reg.user.id, { state: 'frozen', reason: 'review' });

  // Login still works (so they can withdraw their funds).
  const relog = await auth.login({ email: 'frozen@example.com', password: creds.password });
  assert.equal(relog.user.id, reg.user.id);
  // But the real-money gate blocks them.
  const gate = await auth.checkAccountRealMoney(reg.user.id);
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'account_frozen');
});

test('reactivating clears the block', async () => {
  const { auth } = makeService();
  const reg = await auth.register({ ...creds, username: 'reactu', email: 'react@example.com' });
  await auth.setAccountState(reg.user.id, { state: 'banned' });
  await auth.setAccountState(reg.user.id, { state: 'active' });
  const relog = await auth.login({ email: 'react@example.com', password: creds.password });
  assert.equal(relog.user.id, reg.user.id);
  assert.equal((await auth.checkAccountRealMoney(reg.user.id)).allowed, true);
});
