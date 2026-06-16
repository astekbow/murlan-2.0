// ============================================================================
// MURLAN — Auth REST routes (Fastify plugin)
// ----------------------------------------------------------------------------
// register / login / refresh / logout / me. The refresh token lives ONLY in an
// httpOnly, SameSite=Strict cookie (CSRF-resistant: a cross-site request can't
// attach it). The access token is returned in the body and sent by the client
// as an Authorization: Bearer header — not a cookie — so it isn't CSRF-able.
// ============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService, AuthError } from '../auth/authService.ts';

export const REFRESH_COOKIE = 'mrl_refresh';

export interface AuthRoutesDeps {
  auth: AuthService;
  isProd: boolean;
  /** per-IP rate-limit applied to register / verify / forgot / reset, if rate-limit is registered */
  authRateLimit?: { max: number; timeWindow: string };
  /** stricter per-IP rate-limit for login specifically (brute-force target); falls back to authRateLimit */
  loginRateLimit?: { max: number; timeWindow: string };
}

function setRefreshCookie(reply: FastifyReply, token: string, isProd: boolean): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProd,
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60, // 7 days (seconds)
  });
}

function handleAuthError(reply: FastifyReply, e: unknown): void {
  if (e instanceof AuthError) {
    const status = e.code === 'validation' ? 400
      : e.code === 'unauthorized' || e.code === 'bad_refresh' ? 401
      : e.code === 'bad_credentials' ? 401
      : e.code === 'rate_limited' ? 429
      : e.code === 'email_taken' || e.code === 'username_taken' ? 409
      : 400;
    reply.code(status).send({ error: { code: e.code, message: e.message } });
    return;
  }
  reply.code(500).send({ error: { code: 'internal', message: 'Gabim i brendshëm.' } });
}

/** Extract a Bearer access token and resolve the caller, or send 401. */
export function requireAuth(auth: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; username: string } | null> => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Mungon token-i.' } });
      return null;
    }
    try {
      return auth.verifyAccess(token);
    } catch {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'Token i pavlefshëm.' } });
      return null;
    }
  };
}

/** Like requireAuth, but also requires the caller to have the admin role. */
export function requireAdmin(auth: AuthService) {
  const base = requireAuth(auth);
  return async (req: FastifyRequest, reply: FastifyReply): Promise<{ userId: string; username: string } | null> => {
    const caller = await base(req, reply);
    if (!caller) return null;
    const user = await auth.getUser(caller.userId);
    if (!user || user.role !== 'admin') {
      reply.code(403).send({ error: { code: 'forbidden', message: 'Vetëm administratorët.' } });
      return null;
    }
    return caller;
  };
}

export async function authRoutes(app: FastifyInstance, deps: AuthRoutesDeps): Promise<void> {
  const { auth, isProd } = deps;
  const guard = requireAuth(auth);
  const rl = deps.authRateLimit ? { config: { rateLimit: deps.authRateLimit } } : {};
  // Login gets its own (tighter) per-IP bucket; the per-EMAIL throttle in AuthService
  // is the IP-rotation-proof layer on top.
  const loginRl = (deps.loginRateLimit ?? deps.authRateLimit) ? { config: { rateLimit: deps.loginRateLimit ?? deps.authRateLimit } } : {};

  app.post('/api/auth/register', rl, async (req, reply) => {
    try {
      const { user, tokens } = await auth.register(req.body);
      setRefreshCookie(reply, tokens.refreshToken, isProd);
      return reply.code(201).send({ user, accessToken: tokens.accessToken });
    } catch (e) {
      handleAuthError(reply, e);
    }
  });

  app.post('/api/auth/login', loginRl, async (req, reply) => {
    try {
      const { user, tokens } = await auth.login(req.body);
      setRefreshCookie(reply, tokens.refreshToken, isProd);
      return reply.send({ user, accessToken: tokens.accessToken });
    } catch (e) {
      handleAuthError(reply, e);
    }
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const token = (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    if (!token) {
      return reply.code(401).send({ error: { code: 'bad_refresh', message: 'Sesioni ka skaduar. Hyr përsëri.' } });
    }
    try {
      const { tokens, user } = await auth.refresh(token);
      setRefreshCookie(reply, tokens.refreshToken, isProd);
      return reply.send({ user, accessToken: tokens.accessToken });
    } catch (e) {
      handleAuthError(reply, e);
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    // Real logout: REVOKE the refresh token server-side (not just clear the
    // cookie), so a captured copy can't be replayed for the rest of its 7-day TTL.
    const token = (req.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    await auth.logout(token);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return reply.send({ ok: true });
  });

  // ----- Email verification & password reset --------------------------------
  app.post('/api/auth/verify-email/request', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return;
    await auth.requestEmailVerification(caller.userId);
    return reply.send({ ok: true }); // sent (or already verified) — don't leak which
  });

  app.post('/api/auth/verify-email/confirm', rl, async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: unknown };
    if (typeof token !== 'string' || !token) return reply.code(400).send({ error: { code: 'bad_request', message: 'Mungon token-i.' } });
    const ok = await auth.confirmEmailVerification(token);
    if (!ok) return reply.code(400).send({ error: { code: 'invalid_token', message: 'Lidhja është e pavlefshme ose ka skaduar.' } });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/forgot-password', rl, async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: unknown };
    if (typeof email === 'string') await auth.requestPasswordReset(email);
    // ALWAYS 200, regardless of whether the email exists (no account enumeration).
    return reply.send({ ok: true });
  });

  app.post('/api/auth/reset-password', rl, async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: unknown; password?: unknown };
    if (typeof token !== 'string' || !token || typeof password !== 'string') {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Të dhëna të pavlefshme.' } });
    }
    try {
      const ok = await auth.resetPassword(token, password);
      if (!ok) return reply.code(400).send({ error: { code: 'invalid_token', message: 'Lidhja është e pavlefshme ose ka skaduar.' } });
      return reply.send({ ok: true });
    } catch (e) {
      handleAuthError(reply, e);
    }
  });

  app.get('/api/auth/me', async (req, reply) => {
    const caller = await guard(req, reply);
    if (!caller) return; // guard already replied 401
    const user = await auth.getUser(caller.userId);
    if (!user) return reply.code(404).send({ error: { code: 'not_found', message: 'Përdoruesi nuk u gjet.' } });
    return reply.send({ user });
  });
}
