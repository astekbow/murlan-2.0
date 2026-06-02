import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildHttpApp } from '../app.ts';
import { InMemoryUserRepository } from '../auth/userRepository.ts';
import { TokenService } from '../auth/tokens.ts';
import { AuthService } from '../auth/authService.ts';
import { loadConfig } from '../config.ts';
import { REFRESH_COOKIE } from './authRoutes.ts';

async function buildApp(): Promise<FastifyInstance> {
  const auth = new AuthService(
    new InMemoryUserRepository(),
    new TokenService({ accessSecret: 'a', refreshSecret: 'r' }),
  );
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  return buildHttpApp({ auth, config });
}

const creds = { username: 'lojtari', email: 'lojtar@example.com', password: 'password123' };

function refreshCookieFrom(res: { cookies: Array<{ name: string; value: string }> }): string | undefined {
  return res.cookies.find((ck) => ck.name === REFRESH_COOKIE)?.value;
}

test('health endpoint responds ok', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  await app.close();
});

test('POST /register creates an account, returns an access token + httpOnly refresh cookie', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.user.username, 'lojtari');
  assert.ok(body.accessToken.length > 0);

  const cookie = res.cookies.find((ck) => ck.name === REFRESH_COOKIE)!;
  assert.ok(cookie, 'refresh cookie set');
  assert.equal(cookie.httpOnly, true);
  assert.equal(String(cookie.sameSite).toLowerCase(), 'strict');
  await app.close();
});

test('POST /register rejects duplicate email with 409', async () => {
  const app = await buildApp();
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });
  const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { ...creds, username: 'tjeter' } });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().error.code, 'email_taken');
  await app.close();
});

test('POST /register rejects invalid input with 400', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'x', email: 'bad', password: 'short' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'validation');
  await app.close();
});

test('POST /login returns 401 on bad credentials and 200 on good', async () => {
  const app = await buildApp();
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });

  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: creds.email, password: 'wrong-pass' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error.code, 'bad_credentials');

  const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: creds.email, password: creds.password } });
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().user.username, 'lojtari');
  await app.close();
});

test('GET /me requires a Bearer token and returns the caller', async () => {
  const app = await buildApp();
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });
  const token = reg.json().accessToken as string;

  const unauth = await app.inject({ method: 'GET', url: '/api/auth/me' });
  assert.equal(unauth.statusCode, 401);

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().user.email, 'lojtar@example.com');
  await app.close();
});

test('POST /refresh rotates tokens using the httpOnly cookie; logout clears it', async () => {
  const app = await buildApp();
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });
  const refreshCookie = refreshCookieFrom(reg)!;
  assert.ok(refreshCookie);

  const refreshed = await app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    cookies: { [REFRESH_COOKIE]: refreshCookie },
  });
  assert.equal(refreshed.statusCode, 200);
  assert.ok((refreshed.json().accessToken as string).length > 0);

  // Without the cookie, refresh is unauthorized.
  const noCookie = await app.inject({ method: 'POST', url: '/api/auth/refresh' });
  assert.equal(noCookie.statusCode, 401);

  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout' });
  assert.equal(logout.statusCode, 200);
  await app.close();
});
