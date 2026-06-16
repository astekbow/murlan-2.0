import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryUserRepository, DuplicateUserError } from './userRepository.ts';
import { TokenService } from './tokens.ts';
import { AuthService, AuthError } from './authService.ts';
import type { OutboundEmail, EmailProvider } from '../email/emailProvider.ts';

class CapturingEmail implements EmailProvider {
  readonly name = 'capturing';
  sent: OutboundEmail[] = [];
  async send(email: OutboundEmail): Promise<void> {
    this.sent.push(email);
  }
  lastLink(): string {
    const m = /\?\w+=([0-9a-f]+)/.exec(this.sent.at(-1)?.text ?? '');
    return m?.[1] ?? '';
  }
}

function makeService() {
  const repo = new InMemoryUserRepository();
  const tokens = new TokenService({
    accessSecret: 'test-access-secret',
    refreshSecret: 'test-refresh-secret',
    accessTtl: '15m',
    refreshTtl: '7d',
  });
  const email = new CapturingEmail();
  return { repo, tokens, email, auth: new AuthService(repo, tokens, undefined, { email }) };
}

const valid = { username: 'driloni', email: 'Dril@example.com', password: 'supersecret1' };

test('register creates a user, hashes the password, and returns tokens', async () => {
  const { auth } = makeService();
  const res = await auth.register(valid);
  assert.equal(res.user.username, 'driloni');
  assert.equal(res.user.email, 'dril@example.com'); // normalised to lowercase
  assert.equal(res.user.role, 'user');
  assert.equal(res.user.balanceCents, 0);
  assert.ok(res.tokens.accessToken.length > 0);
  assert.ok(res.tokens.refreshToken.length > 0);
});

test('register rejects weak/invalid input with a player-facing message', async () => {
  const { auth } = makeService();
  await assert.rejects(
    auth.register({ username: 'ab', email: 'x@y.com', password: 'longenough' }),
    (e: unknown) => e instanceof AuthError && e.code === 'validation',
  );
  await assert.rejects(
    auth.register({ username: 'okname', email: 'not-an-email', password: 'longenough' }),
    (e: unknown) => e instanceof AuthError && e.code === 'validation',
  );
  await assert.rejects(
    auth.register({ username: 'okname', email: 'a@b.com', password: 'short' }),
    (e: unknown) => e instanceof AuthError && e.code === 'validation',
  );
});

test('repository create throws a typed DuplicateUserError on collision (maps to 409)', async () => {
  const repo = new InMemoryUserRepository();
  await repo.create({ username: 'a', email: 'a@x.com', passwordHash: 'h' });
  await assert.rejects(
    repo.create({ username: 'b', email: 'A@x.com', passwordHash: 'h' }),
    (e: unknown) => e instanceof DuplicateUserError && e.field === 'email',
  );
  await assert.rejects(
    repo.create({ username: 'A', email: 'c@x.com', passwordHash: 'h' }),
    (e: unknown) => e instanceof DuplicateUserError && e.field === 'username',
  );
});

test('register enforces unique email and username (case-insensitive)', async () => {
  const { auth } = makeService();
  await auth.register(valid);
  await assert.rejects(
    auth.register({ ...valid, username: 'other' }), // same email, different case handled
    (e: unknown) => e instanceof AuthError && e.code === 'email_taken',
  );
  await assert.rejects(
    auth.register({ ...valid, email: 'new@example.com', username: 'DRILONI' }),
    (e: unknown) => e instanceof AuthError && e.code === 'username_taken',
  );
});

test('login succeeds with correct credentials and fails otherwise', async () => {
  const { auth } = makeService();
  await auth.register(valid);

  const ok = await auth.login({ email: 'dril@example.com', password: 'supersecret1' });
  assert.equal(ok.user.username, 'driloni');

  await assert.rejects(
    auth.login({ email: 'dril@example.com', password: 'wrongpass' }),
    (e: unknown) => e instanceof AuthError && e.code === 'bad_credentials',
  );
  // Unknown email yields the SAME generic error (no account enumeration).
  await assert.rejects(
    auth.login({ email: 'nobody@example.com', password: 'whatever1' }),
    (e: unknown) => e instanceof AuthError && e.code === 'bad_credentials',
  );
});

// ---- per-email login throttle (MONEY-7/WEB-2) -----------------------------
function makeThrottled(maxFailures = 3, windowMs = 60_000) {
  const repo = new InMemoryUserRepository();
  const tokens = new TokenService({ accessSecret: 'a', refreshSecret: 'b', accessTtl: '15m', refreshTtl: '7d' });
  let clock = 1_000_000;
  const auth = new AuthService(repo, tokens, undefined, { now: () => clock, loginThrottle: { maxFailures, windowMs } });
  return { auth, advance: (ms: number) => { clock += ms; } };
}

test('login throttle: locks an email after N failures — even with the RIGHT password — then unlocks after the window', async () => {
  const { auth, advance } = makeThrottled(3, 60_000);
  await auth.register({ username: 'victim', email: 'v@x.com', password: 'correct-horse' });

  for (let i = 0; i < 3; i++) {
    await assert.rejects(auth.login({ email: 'v@x.com', password: 'wrong-pass' }), (e: unknown) => e instanceof AuthError && e.code === 'bad_credentials');
  }
  // 4th attempt is throttled regardless of the password → proxy-IP rotation can't help.
  await assert.rejects(auth.login({ email: 'v@x.com', password: 'correct-horse' }), (e: unknown) => e instanceof AuthError && e.code === 'rate_limited');

  advance(60_001); // window elapses
  const ok = await auth.login({ email: 'v@x.com', password: 'correct-horse' });
  assert.equal(ok.user.username, 'victim');
});

test('login throttle: a successful login clears the failure counter', async () => {
  const { auth } = makeThrottled(3, 60_000);
  await auth.register({ username: 'player1', email: 'u@x.com', password: 'correct-horse' });

  await assert.rejects(auth.login({ email: 'u@x.com', password: 'wrong-pass' }), (e: unknown) => e instanceof AuthError && e.code === 'bad_credentials');
  await assert.rejects(auth.login({ email: 'u@x.com', password: 'wrong-pass' }), (e: unknown) => e instanceof AuthError && e.code === 'bad_credentials');
  await auth.login({ email: 'u@x.com', password: 'correct-horse' }); // success → reset

  // Counter reset → it takes a fresh 3 failures (not 1) to lock again.
  for (let i = 0; i < 3; i++) {
    await assert.rejects(auth.login({ email: 'u@x.com', password: 'wrong-pass' }), (e: unknown) => e instanceof AuthError && e.code === 'bad_credentials');
  }
  await assert.rejects(auth.login({ email: 'u@x.com', password: 'correct-horse' }), (e: unknown) => e instanceof AuthError && e.code === 'rate_limited');
});

test('login throttle: applies to UNKNOWN emails too (no enumeration via lockout behavior)', async () => {
  const { auth } = makeThrottled(3, 60_000);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(auth.login({ email: 'ghost@x.com', password: 'whatever1' }), (e: unknown) => e instanceof AuthError && e.code === 'bad_credentials');
  }
  // A non-existent email locks identically to a real one — same observable behavior.
  await assert.rejects(auth.login({ email: 'ghost@x.com', password: 'whatever1' }), (e: unknown) => e instanceof AuthError && e.code === 'rate_limited');
});

test('verifyAccess accepts a freshly issued access token', async () => {
  const { auth } = makeService();
  const res = await auth.register(valid);
  const claims = auth.verifyAccess(res.tokens.accessToken);
  assert.equal(claims.username, 'driloni');
  assert.ok(claims.userId.length > 0);
});

test('a refresh token cannot be used as an access token', async () => {
  const { auth } = makeService();
  const res = await auth.register(valid);
  assert.throws(() => auth.verifyAccess(res.tokens.refreshToken), AuthError);
});

test('refresh exchanges a valid refresh token for a new pair', async () => {
  const { auth } = makeService();
  const res = await auth.register(valid);
  const refreshed = await auth.refresh(res.tokens.refreshToken);
  assert.ok(refreshed.tokens.accessToken.length > 0);
  // The new access token authenticates the same user.
  assert.equal(auth.verifyAccess(refreshed.tokens.accessToken).username, 'driloni');
});

test('refresh rejects a garbage token', async () => {
  const { auth } = makeService();
  await assert.rejects(
    auth.refresh('not-a-real-token'),
    (e: unknown) => e instanceof AuthError && e.code === 'bad_refresh',
  );
});

test('refresh ROTATES: the old token is revoked, and replaying it kills the whole family', async () => {
  const { auth } = makeService();
  const res = await auth.register(valid);
  const r1 = res.tokens.refreshToken;

  const rotated = await auth.refresh(r1); // r1 -> r2 (r1 now revoked)
  const r2 = rotated.tokens.refreshToken;
  assert.notEqual(r1, r2);

  // Replaying the rotated-away r1 is rejected AND, as reuse detection, revokes
  // the family — so the legitimately-rotated r2 is also invalidated.
  await assert.rejects(auth.refresh(r1), (e: unknown) => e instanceof AuthError && e.code === 'bad_refresh');
  await assert.rejects(auth.refresh(r2), (e: unknown) => e instanceof AuthError && e.code === 'bad_refresh');
});

test('logout revokes the refresh token (it can no longer be refreshed)', async () => {
  const { auth } = makeService();
  const res = await auth.register(valid);
  await auth.logout(res.tokens.refreshToken);
  await assert.rejects(auth.refresh(res.tokens.refreshToken), (e: unknown) => e instanceof AuthError && e.code === 'bad_refresh');
});

test('bumping tokenVersion (logout-all / ban) invalidates existing refresh tokens', async () => {
  const { auth, repo } = makeService();
  const res = await auth.register(valid);
  const me = await repo.findByEmail(valid.email);
  await auth.revokeAllSessions(me!.id);
  await assert.rejects(auth.refresh(res.tokens.refreshToken), (e: unknown) => e instanceof AuthError && e.code === 'bad_refresh');
});

test('email verification: a token from the link flips emailVerified; reuse fails', async () => {
  const { auth, repo, email } = makeService();
  await auth.register(valid);
  const me = await repo.findByEmail(valid.email);
  assert.equal(me!.emailVerified, false);

  await auth.requestEmailVerification(me!.id);
  const token = email.lastLink();
  assert.ok(token.length > 0);

  assert.equal(await auth.confirmEmailVerification(token), true);
  assert.equal((await repo.findById(me!.id))!.emailVerified, true);
  assert.equal(await auth.confirmEmailVerification(token), false); // single-use
});

test('password reset: link sets a new password, invalidates old, and revokes sessions', async () => {
  const { auth, repo, email } = makeService();
  const reg = await auth.register(valid);

  await auth.requestPasswordReset(valid.email);
  const token = email.lastLink();
  assert.ok(token.length > 0);

  assert.equal(await auth.resetPassword(token, 'brandnewpass9'), true);
  // Old password no longer logs in; the new one does.
  await assert.rejects(auth.login({ email: valid.email, password: valid.password }), (e: unknown) => e instanceof AuthError);
  const relog = await auth.login({ email: valid.email, password: 'brandnewpass9' });
  assert.ok(relog.tokens.accessToken.length > 0);
  // The reset revoked existing sessions (the pre-reset refresh token is dead).
  await assert.rejects(auth.refresh(reg.tokens.refreshToken), (e: unknown) => e instanceof AuthError && e.code === 'bad_refresh');
  // The reset token is single-use.
  assert.equal(await auth.resetPassword(token, 'anotherpass9'), false);
});

test('forgot-password for an unknown email is a silent no-op (no enumeration)', async () => {
  const { auth, email } = makeService();
  await auth.requestPasswordReset('nobody@nowhere.com');
  assert.equal(email.sent.length, 0); // nothing sent, but the route still returns ok
});

test('resetPassword rejects a weak new password', async () => {
  const { auth, email } = makeService();
  await auth.register(valid);
  await auth.requestPasswordReset(valid.email);
  await assert.rejects(auth.resetPassword(email.lastLink(), 'short'), (e: unknown) => e instanceof AuthError && e.code === 'validation');
});

test('updateSelfProfile: editable before KYC, LOCKED after verification (service-layer gate)', async () => {
  const { auth, repo } = makeService();
  await auth.register(valid);
  const me = (await repo.findByEmail(valid.email))!;

  // Before verification: DOB/country editable; the change is flagged for audit.
  const r1 = await auth.updateSelfProfile(me.id, { dateOfBirth: '1990-05-01', country: 'al' });
  assert.equal(r1.ok, true);
  assert.equal((r1 as { changed: boolean }).changed, true);

  // After KYC verification: the SERVICE rejects DOB/country changes (not just the route).
  await auth.updateCompliance(me.id, { kycStatus: 'verified' });
  const r2 = await auth.updateSelfProfile(me.id, { dateOfBirth: '2004-01-01', country: 'gb' });
  assert.deepEqual(r2, { ok: false, code: 'kyc_locked' });

  // Re-submitting the SAME verified values is a no-op (changed=false), not a lock error.
  const r3 = await auth.updateSelfProfile(me.id, { dateOfBirth: '1990-05-01', country: 'AL' });
  assert.equal(r3.ok, true);
  assert.equal((r3 as { changed: boolean }).changed, false);
});
