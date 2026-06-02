// ============================================================================
// MURLAN — Friendships (Phase 5, §2.5)
// ----------------------------------------------------------------------------
// A directed request (requester → addressee) that becomes a mutual friendship
// once accepted. Repository interface so it runs in-memory (tests/dev) or on
// Postgres/Prisma (prod). No money/game state here.
// ============================================================================

export type FriendStatus = 'pending' | 'accepted' | 'blocked';

export interface Friendship {
  id: string;
  requesterId: string;
  addresseeId: string;
  status: FriendStatus;
  createdAt: number; // epoch ms
}

export interface FriendsRepository {
  /** Create a pending request, or return the existing edge between the two. */
  request(requesterId: string, addresseeId: string): Promise<Friendship>;
  /** The addressee accepts (or the row is removed on decline). Returns the row, or null if not actionable by this user. */
  respond(id: string, userId: string, accept: boolean): Promise<Friendship | null>;
  /** Either party removes/cancels the friendship. */
  remove(id: string, userId: string): Promise<boolean>;
  /** Every friendship row that involves `userId` (either side). */
  listFor(userId: string): Promise<Friendship[]>;
  findBetween(a: string, b: string): Promise<Friendship | null>;
  /** `blockerId` blocks `blockedId`: drop any existing edge, record a directed
   *  'blocked' edge (requester = blocker). Suppresses future requests/invites. */
  block(blockerId: string, blockedId: string): Promise<void>;
  /** Remove a block `blockerId` placed on `blockedId` (no-op if none). */
  unblock(blockerId: string, blockedId: string): Promise<void>;
}

export class InMemoryFriends implements FriendsRepository {
  private rows = new Map<string, Friendship>();
  private seq = 0;

  async request(requesterId: string, addresseeId: string): Promise<Friendship> {
    if (requesterId === addresseeId) throw new Error('cannot befriend yourself');
    const existing = await this.findBetween(requesterId, addresseeId);
    if (existing) return { ...existing };
    this.seq += 1;
    const row: Friendship = { id: `f_${this.seq}`, requesterId, addresseeId, status: 'pending', createdAt: Date.now() };
    this.rows.set(row.id, row);
    return { ...row };
  }

  async respond(id: string, userId: string, accept: boolean): Promise<Friendship | null> {
    const row = this.rows.get(id);
    if (!row || row.addresseeId !== userId || row.status !== 'pending') return null; // only the addressee acts on a pending request
    if (!accept) { this.rows.delete(id); return null; }
    row.status = 'accepted';
    return { ...row };
  }

  async remove(id: string, userId: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || (row.requesterId !== userId && row.addresseeId !== userId)) return false;
    this.rows.delete(id);
    return true;
  }

  async listFor(userId: string): Promise<Friendship[]> {
    return [...this.rows.values()].filter((r) => r.requesterId === userId || r.addresseeId === userId).map((r) => ({ ...r }));
  }

  async findBetween(a: string, b: string): Promise<Friendship | null> {
    for (const r of this.rows.values()) {
      if ((r.requesterId === a && r.addresseeId === b) || (r.requesterId === b && r.addresseeId === a)) return { ...r };
    }
    return null;
  }

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) return;
    for (const [id, r] of this.rows) {
      if ((r.requesterId === blockerId && r.addresseeId === blockedId) || (r.requesterId === blockedId && r.addresseeId === blockerId)) {
        this.rows.delete(id);
      }
    }
    this.seq += 1;
    const row: Friendship = { id: `f_${this.seq}`, requesterId: blockerId, addresseeId: blockedId, status: 'blocked', createdAt: Date.now() };
    this.rows.set(row.id, row);
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    for (const [id, r] of this.rows) {
      if (r.status === 'blocked' && r.requesterId === blockerId && r.addresseeId === blockedId) this.rows.delete(id);
    }
  }
}
