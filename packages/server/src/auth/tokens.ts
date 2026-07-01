// JWT access/refresh tokens. Access tokens are short-lived and authorise both
// REST requests and the Socket.IO handshake; refresh tokens mint new pairs.
// A `type` claim prevents a refresh token from being used as an access token.

import jwt from 'jsonwebtoken';

// Pin the signing algorithm + bind issuer/audience. Without an explicit
// `algorithms` allowlist on verify, jsonwebtoken honours the token's own `alg`
// header — the classic algorithm-confusion footgun (alg:none / RS256 with the
// public key as HMAC secret). HS256 is symmetric and the only algorithm we use.
const ALG: jwt.Algorithm = 'HS256';
const ISSUER = 'murlan';
const AUDIENCE = 'murlan';

export interface TokenClaims {
  sub: string;      // user id
  username: string;
  type: 'access' | 'refresh';
  ver: number;      // user.tokenVersion at issue — revocation-aware: a force-logout/ban/
                    // reset bumps tokenVersion, so a stale access token is rejected at
                    // verify time (requireAuth compares ver to the live tokenVersion).
}

export interface RefreshClaims extends TokenClaims {
  type: 'refresh';
  jti: string;      // unique token id (rotation + revocation key)
  family: string;   // rotation chain id (reuse of a revoked jti revokes the family)
  ver: number;      // user.tokenVersion at issue (force-logout invalidates all)
}

export interface RefreshIssueOpts {
  jti: string;
  family: string;
  ver: number;
}

export interface TokenConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtl?: string | number;  // e.g. '15m', '7d', or seconds; default '15m'
  refreshTtl?: string | number; // default '7d'
}

// `expiresIn` in @types/jsonwebtoken@9 is a narrow template-literal type; we
// accept friendly strings publicly and cast at the single call site below.
type ExpiresIn = jwt.SignOptions['expiresIn'];

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export class TokenService {
  constructor(private readonly cfg: TokenConfig) {}

  private signOpts(expiresIn: string | number, sub: string): jwt.SignOptions {
    return { subject: sub, expiresIn: expiresIn as ExpiresIn, algorithm: ALG, issuer: ISSUER, audience: AUDIENCE };
  }
  private verifyOpts(): jwt.VerifyOptions {
    return { algorithms: [ALG], issuer: ISSUER, audience: AUDIENCE };
  }

  issueAccess(sub: string, username: string, ver = 0): string {
    return jwt.sign({ username, type: 'access', ver } satisfies Omit<TokenClaims, 'sub'>, this.cfg.accessSecret, this.signOpts(this.cfg.accessTtl ?? '15m', sub));
  }

  /** Issue a refresh token bound to a server-side record (jti/family/ver). */
  issueRefresh(sub: string, username: string, opts: RefreshIssueOpts): string {
    return jwt.sign(
      { username, type: 'refresh', jti: opts.jti, family: opts.family, ver: opts.ver } satisfies Omit<RefreshClaims, 'sub'>,
      this.cfg.refreshSecret,
      this.signOpts(this.cfg.refreshTtl ?? '7d', sub),
    );
  }

  /** Convenience: a plain access+refresh pair (no rotation metadata). Used by
   *  tests that just need an access token; production uses issueAccess +
   *  issueRefresh with a persisted record. */
  issuePair(sub: string, username: string, ver = 0): TokenPair {
    return {
      accessToken: this.issueAccess(sub, username, ver),
      refreshToken: jwt.sign({ username, type: 'refresh', ver } satisfies Omit<TokenClaims, 'sub'>, this.cfg.refreshSecret, this.signOpts(this.cfg.refreshTtl ?? '7d', sub)),
    };
  }

  verifyAccess(token: string): TokenClaims {
    return this.verify(token, this.cfg.accessSecret, 'access');
  }

  /** Verify a refresh token. jti/family/ver are present for tokens issued via
   *  issueRefresh; undefined for legacy issuePair tokens. */
  verifyRefresh(token: string): RefreshClaims {
    const decoded = jwt.verify(token, this.cfg.refreshSecret, this.verifyOpts()) as jwt.JwtPayload;
    if (decoded.type !== 'refresh' || typeof decoded.sub !== 'string') throw new Error('invalid refresh token');
    // auth: a refresh token MUST carry a numeric `ver` (the revocation gate), like verifyAccess.
    // Don't silently default a missing `ver` to 0 — a pre-`ver` legacy token is rejected → forces
    // a fresh login once. (issueRefresh/issuePair both set a numeric ver, so those are unaffected.)
    if (typeof decoded.ver !== 'number') throw new Error('invalid refresh token');
    return {
      sub: decoded.sub,
      username: String(decoded.username ?? ''),
      type: 'refresh',
      jti: typeof decoded.jti === 'string' ? decoded.jti : '',
      family: typeof decoded.family === 'string' ? decoded.family : '',
      ver: decoded.ver,
    };
  }

  private verify(token: string, secret: string, expected: 'access' | 'refresh'): TokenClaims {
    const decoded = jwt.verify(token, secret, this.verifyOpts()) as jwt.JwtPayload;
    if (decoded.type !== expected || typeof decoded.sub !== 'string') {
      throw new Error(`invalid ${expected} token`);
    }
    // Revocation-aware: an access token MUST carry a numeric `ver` claim. A legacy
    // token minted before this change has no `ver` → rejected (treated as invalid),
    // forcing a refresh that re-issues a versioned token.
    if (typeof decoded.ver !== 'number') {
      throw new Error(`invalid ${expected} token`);
    }
    return { sub: decoded.sub, username: String(decoded.username ?? ''), type: expected, ver: decoded.ver };
  }
}
