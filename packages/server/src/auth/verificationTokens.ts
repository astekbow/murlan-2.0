// Single-use, hashed, expiring tokens for email verification + password reset.
// Only the SHA-256 hash is persisted; the raw token travels solely in the emailed
// link. A token is valid only if it matches the requested type, is unexpired, and
// has not been consumed.

import { createHash, randomBytes } from 'node:crypto';

export type VerificationTokenType = 'email_verify' | 'password_reset';

export interface VerificationTokenRecord {
  id: string;
  userId: string;
  type: VerificationTokenType;
  tokenHash: string;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

export interface NewVerificationToken {
  userId: string;
  type: VerificationTokenType;
  tokenHash: string;
  expiresAt: number;
}

export interface VerificationTokenRepository {
  create(r: NewVerificationToken): Promise<void>;
  /** A matching-type token that is unexpired and unused, by its hash. */
  findValidByHash(tokenHash: string, type: VerificationTokenType, nowMs: number): Promise<VerificationTokenRecord | null>;
  consume(id: string, nowMs: number): Promise<void>;
  /** Purge tokens past their expiry (retention/cleanup). Returns rows removed. */
  deleteExpired(nowMs: number): Promise<number>;
}

/** Hash a raw token for storage/lookup (raw never persisted). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** A fresh URL-safe random token (raw — emailed once, never stored). */
export function generateRawToken(): string {
  return randomBytes(32).toString('hex');
}

export class InMemoryVerificationTokens implements VerificationTokenRepository {
  private byHash = new Map<string, VerificationTokenRecord>();
  private seq = 0;

  async create(r: NewVerificationToken): Promise<void> {
    this.seq += 1;
    this.byHash.set(r.tokenHash, { id: `vt_${this.seq}`, ...r, usedAt: null, createdAt: Date.now() });
  }
  async findValidByHash(tokenHash: string, type: VerificationTokenType, nowMs: number): Promise<VerificationTokenRecord | null> {
    const r = this.byHash.get(tokenHash);
    if (!r || r.type !== type || r.usedAt !== null || r.expiresAt < nowMs) return null;
    return { ...r };
  }
  async consume(id: string, nowMs: number): Promise<void> {
    for (const r of this.byHash.values()) if (r.id === id) r.usedAt = nowMs;
  }
  async deleteExpired(nowMs: number): Promise<number> {
    let n = 0;
    for (const [hash, r] of this.byHash) if (r.expiresAt < nowMs) { this.byHash.delete(hash); n++; }
    return n;
  }
}
