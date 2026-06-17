// ============================================================================
// MURLAN — Friends service (Phase 5, §2.5)
// ----------------------------------------------------------------------------
// Resolves friendship rows into a UI-friendly list (the other party's public
// info + online presence + my action direction). No money/game state.
// ============================================================================

import type { UserRepository } from '../auth/userRepository.ts';
import type { FriendsRepository, Friendship } from './friendsRepository.ts';
import type { Presence } from '../realtime/presence.ts';
import { levelInfo } from '../profile/level.ts';

export class FriendsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FriendsError';
  }
}

export interface FriendEntry {
  id: string; // friendship id
  status: 'pending' | 'accepted' | 'blocked';
  direction: 'incoming' | 'outgoing' | 'friends' | 'blocked';
  online: boolean;
  user: { id: string; username: string; avatar: string | null; level: number };
}

export class FriendsService {
  /** Optional real-time hook: notify a user that they received a friend request.
   *  Wired by the gateway (which has the socket io) so this stays io-agnostic. */
  private notifier: ((targetUserId: string, fromUsername: string) => void) | null = null;

  constructor(
    private readonly users: UserRepository,
    private readonly friends: FriendsRepository,
    private readonly presence: Presence,
  ) {}

  setNotifier(fn: (targetUserId: string, fromUsername: string) => void): void {
    this.notifier = fn;
  }

  /**
   * Send a friend request by username. ENUMERATION-SAFE: returns null (instead of a
   * distinct error) when the username doesn't exist OR a block is in place, so the route
   * can respond IDENTICALLY to a real send — an attacker can't tell which usernames exist
   * (same approach as forgot-password). Adding yourself is the only distinct error, and
   * that leaks nothing (you already know your own username).
   */
  async requestByUsername(requesterId: string, username: string): Promise<Friendship | null> {
    const target = await this.users.findByUsername(username.trim());
    if (target && target.id === requesterId) throw new FriendsError('self', 'Nuk mund të shtosh veten.');
    if (!target) return null; // unknown username → uniform "sent" response (no leak)
    // A block in EITHER direction stops a new request — also returned as null so it
    // doesn't reveal that the user exists or that a block is in place.
    const edge = await this.friends.findBetween(requesterId, target.id);
    if (edge?.status === 'blocked') return null;
    const row = await this.friends.request(requesterId, target.id);
    // Real-time ping to the recipient (best-effort; ignore if they're offline).
    if (this.notifier) {
      const me = await this.users.findById(requesterId);
      if (me) this.notifier(target.id, me.username);
    }
    return row;
  }

  /** respond returns the row (or null when not actionable by this user). */
  async respond(userId: string, friendshipId: string, accept: boolean): Promise<Friendship | null> {
    return this.friends.respond(friendshipId, userId, accept);
  }

  async remove(userId: string, friendshipId: string): Promise<boolean> {
    return this.friends.remove(friendshipId, userId);
  }

  /** Block another user by their id (removes any friendship/request first). */
  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) throw new FriendsError('self', 'Nuk mund të bllokosh veten.');
    await this.friends.block(blockerId, blockedId);
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.friends.unblock(blockerId, blockedId);
  }

  /** A user's friends + pending requests, with the other party resolved. */
  async list(userId: string): Promise<FriendEntry[]> {
    const rows = await this.friends.listFor(userId);
    const entries = await Promise.all(
      rows.map(async (r): Promise<FriendEntry | null> => {
        const otherId = r.requesterId === userId ? r.addresseeId : r.requesterId;
        // A block is one-directional and private: show it only to the blocker
        // (so they can unblock); hide it entirely from the person who was blocked.
        if (r.status === 'blocked' && r.requesterId !== userId) return null;
        const other = await this.users.findById(otherId);
        if (!other) return null;
        const direction: FriendEntry['direction'] =
          r.status === 'blocked' ? 'blocked' : r.status === 'accepted' ? 'friends' : r.addresseeId === userId ? 'incoming' : 'outgoing';
        return {
          id: r.id,
          status: r.status,
          direction,
          online: this.presence.isOnline(otherId),
          user: { id: other.id, username: other.username, avatar: other.avatar, level: levelInfo(other.xp).level },
        };
      }),
    );
    return entries.filter((e): e is FriendEntry => e !== null);
  }

  /** Are these two accepted friends? (used to gate room invites) */
  async areFriends(a: string, b: string): Promise<boolean> {
    const edge = await this.friends.findBetween(a, b);
    return !!edge && edge.status === 'accepted';
  }
}
