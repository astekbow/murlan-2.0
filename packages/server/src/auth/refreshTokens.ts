// Server-side refresh-token store: turns stateless refresh JWTs into revocable,
// rotating sessions. Each issued refresh token carries a unique `jti` and a
// `family` (rotation chain). On /refresh the presented jti must exist and be
// unrevoked; we then rotate (revoke old, issue new in the same family). A
// presented-but-revoked jti means the token was replayed → revoke the whole
// family (reuse detection). Logout revokes the current jti.

export interface RefreshTokenRecord {
  jti: string;
  userId: string;
  family: string;
  revoked: boolean;
  expiresAt: number; // epoch ms
  createdAt: number;
}

export interface NewRefreshToken {
  jti: string;
  userId: string;
  family: string;
  expiresAt: number;
}

export interface RefreshTokenRepository {
  save(r: NewRefreshToken): Promise<void>;
  find(jti: string): Promise<RefreshTokenRecord | null>;
  revoke(jti: string): Promise<void>;
  /**
   * ATOMIC compare-and-revoke for rotation (auth-3): revoke `jti` ONLY if it is currently
   * unrevoked, returning true iff THIS call performed the revoke (DB updateMany count===1).
   * Two concurrent /refresh calls presenting the SAME stolen token then race here — exactly
   * ONE wins (true) and rotates; the loser sees false and treats it as a detected REUSE
   * (the family is revoked by the caller). No "find then revoke" gap → no two live sessions.
   */
  revokeIfActive(jti: string): Promise<boolean>;
  revokeFamily(family: string): Promise<void>;
  /** Revoke EVERY (unrevoked) refresh token for a user — "log out all devices". The
   *  tokenVersion bump already invalidates them at /refresh; this marks the stored rows
   *  too (defense-in-depth + so a reuse-detection scan never re-arms a dead session). */
  revokeAllForUser(userId: string): Promise<void>;
  /** Purge tokens past their expiry (retention/cleanup). Returns rows removed. */
  deleteExpired(nowMs: number): Promise<number>;
}

export class InMemoryRefreshTokens implements RefreshTokenRepository {
  private byJti = new Map<string, RefreshTokenRecord>();

  async save(r: NewRefreshToken): Promise<void> {
    this.byJti.set(r.jti, { ...r, revoked: false, createdAt: Date.now() });
  }
  async find(jti: string): Promise<RefreshTokenRecord | null> {
    const r = this.byJti.get(jti);
    return r ? { ...r } : null;
  }
  async revoke(jti: string): Promise<void> {
    const r = this.byJti.get(jti);
    if (r) r.revoked = true;
  }
  async revokeIfActive(jti: string): Promise<boolean> {
    const r = this.byJti.get(jti);
    if (!r || r.revoked) return false; // unknown or already-revoked → not us (reuse on a replay)
    r.revoked = true;
    return true; // single-threaded in-memory → this call is the unique winner
  }
  async revokeFamily(family: string): Promise<void> {
    for (const r of this.byJti.values()) if (r.family === family) r.revoked = true;
  }
  async revokeAllForUser(userId: string): Promise<void> {
    for (const r of this.byJti.values()) if (r.userId === userId) r.revoked = true;
  }
  async deleteExpired(nowMs: number): Promise<number> {
    let n = 0;
    for (const [jti, r] of this.byJti) if (r.expiresAt < nowMs) { this.byJti.delete(jti); n++; }
    return n;
  }
}
