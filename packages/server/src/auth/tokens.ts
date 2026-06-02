// JWT access/refresh tokens. Access tokens are short-lived and authorise both
// REST requests and the Socket.IO handshake; refresh tokens mint new pairs.
// A `type` claim prevents a refresh token from being used as an access token.

import jwt from 'jsonwebtoken';

export interface TokenClaims {
  sub: string;      // user id
  username: string;
  type: 'access' | 'refresh';
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

  issueAccess(sub: string, username: string): string {
    return jwt.sign(
      { username, type: 'access' } satisfies Omit<TokenClaims, 'sub'>,
      this.cfg.accessSecret,
      { subject: sub, expiresIn: (this.cfg.accessTtl ?? '15m') as ExpiresIn },
    );
  }

  /** Issue a refresh token bound to a server-side record (jti/family/ver). */
  issueRefresh(sub: string, username: string, opts: RefreshIssueOpts): string {
    return jwt.sign(
      { username, type: 'refresh', jti: opts.jti, family: opts.family, ver: opts.ver } satisfies Omit<RefreshClaims, 'sub'>,
      this.cfg.refreshSecret,
      { subject: sub, expiresIn: (this.cfg.refreshTtl ?? '7d') as ExpiresIn },
    );
  }

  /** Convenience: a plain access+refresh pair (no rotation metadata). Used by
   *  tests that just need an access token; production uses issueAccess +
   *  issueRefresh with a persisted record. */
  issuePair(sub: string, username: string): TokenPair {
    return {
      accessToken: this.issueAccess(sub, username),
      refreshToken: jwt.sign(
        { username, type: 'refresh' } satisfies Omit<TokenClaims, 'sub'>,
        this.cfg.refreshSecret,
        { subject: sub, expiresIn: (this.cfg.refreshTtl ?? '7d') as ExpiresIn },
      ),
    };
  }

  verifyAccess(token: string): TokenClaims {
    return this.verify(token, this.cfg.accessSecret, 'access');
  }

  /** Verify a refresh token. jti/family/ver are present for tokens issued via
   *  issueRefresh; undefined for legacy issuePair tokens. */
  verifyRefresh(token: string): RefreshClaims {
    const decoded = jwt.verify(token, this.cfg.refreshSecret) as jwt.JwtPayload;
    if (decoded.type !== 'refresh' || typeof decoded.sub !== 'string') throw new Error('invalid refresh token');
    return {
      sub: decoded.sub,
      username: String(decoded.username ?? ''),
      type: 'refresh',
      jti: typeof decoded.jti === 'string' ? decoded.jti : '',
      family: typeof decoded.family === 'string' ? decoded.family : '',
      ver: typeof decoded.ver === 'number' ? decoded.ver : 0,
    };
  }

  private verify(token: string, secret: string, expected: 'access' | 'refresh'): TokenClaims {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
    if (decoded.type !== expected || typeof decoded.sub !== 'string') {
      throw new Error(`invalid ${expected} token`);
    }
    return { sub: decoded.sub, username: String(decoded.username ?? ''), type: expected };
  }
}
