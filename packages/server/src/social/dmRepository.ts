// ============================================================================
// MURLAN — Direct messages (1:1 friend DMs) storage. Interface + in-memory impl;
// the Prisma impl in prismaRepositories.ts mirrors it. A DM carries a denormalized
// sender username so a conversation renders without a user join. `readAt` (null =
// unread) drives per-friend unread badges.
// ============================================================================

export interface DirectMessageRecord {
  id: string;
  fromUserId: string;
  fromUsername: string;
  toUserId: string;
  text: string;
  createdAt: number;
  readAt: number | null;
}

export interface DmRepository {
  add(m: { fromUserId: string; fromUsername: string; toUserId: string; text: string }): Promise<DirectMessageRecord>;
  /** The conversation between two users (both directions), oldest→newest, last `limit`. */
  conversation(a: string, b: string, limit: number): Promise<DirectMessageRecord[]>;
  /** Mark every message TO `toUserId` FROM `fromUserId` as read (now). */
  markRead(toUserId: string, fromUserId: string, now: number): Promise<void>;
  /** Unread counts for `toUserId`, keyed by sender id (only senders with ≥1 unread). */
  unreadByFrom(toUserId: string): Promise<Record<string, number>>;
}

export class InMemoryDms implements DmRepository {
  private rows: DirectMessageRecord[] = [];
  private seq = 0;

  async add(m: { fromUserId: string; fromUsername: string; toUserId: string; text: string }): Promise<DirectMessageRecord> {
    const rec: DirectMessageRecord = { id: `dm_${(this.seq += 1)}`, ...m, createdAt: Date.now(), readAt: null };
    this.rows.push(rec);
    return rec;
  }

  async conversation(a: string, b: string, limit: number): Promise<DirectMessageRecord[]> {
    const all = this.rows.filter(
      (r) => (r.fromUserId === a && r.toUserId === b) || (r.fromUserId === b && r.toUserId === a),
    );
    return all.slice(-limit); // oldest→newest, last `limit`
  }

  async markRead(toUserId: string, fromUserId: string, now: number): Promise<void> {
    for (const r of this.rows) {
      if (r.toUserId === toUserId && r.fromUserId === fromUserId && r.readAt === null) r.readAt = now;
    }
  }

  async unreadByFrom(toUserId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const r of this.rows) {
      if (r.toUserId === toUserId && r.readAt === null) out[r.fromUserId] = (out[r.fromUserId] ?? 0) + 1;
    }
    return out;
  }
}
