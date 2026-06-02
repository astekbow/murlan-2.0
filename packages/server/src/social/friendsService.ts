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
  constructor(
    private readonly users: UserRepository,
    private readonly friends: FriendsRepository,
    private readonly presence: Presence,
  ) {}

  async requestByUsername(requesterId: string, username: string): Promise<Friendship> {
    const target = await this.users.findByUsername(username.trim());
    if (!target) throw new FriendsError('not_found', 'Përdoruesi nuk u gjet.');
    if (target.id === requesterId) throw new FriendsError('self', 'Nuk mund të shtosh veten.');
    // A block in EITHER direction stops a new request (and the message is generic
    // so it doesn't reveal who blocked whom).
    const edge = await this.friends.findBetween(requesterId, target.id);
    if (edge?.status === 'blocked') throw new FriendsError('blocked', 'Nuk mund të dërgosh kërkesë te ky përdorues.');
    return this.friends.request(requesterId, target.id);
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
