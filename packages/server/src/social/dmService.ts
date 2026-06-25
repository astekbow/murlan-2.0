// ============================================================================
// MURLAN — Direct-message service: friends-only 1:1 DMs. Send is gated to accepted
// friends (a non-friend / blocked pair can't message), sanitized + length-capped.
// A notifier (wired by the gateway) pushes a real-time 'dm:new' to the recipient.
// ============================================================================

import type { DmRepository, DirectMessageRecord } from './dmRepository.ts';
import type { FriendsService } from './friendsService.ts';
import type { UserRepository } from '../auth/userRepository.ts';

const MAX_DM_LEN = 500;

export interface DirectMessageDTO {
  id: string;
  fromUserId: string;
  fromUsername: string;
  toUserId: string;
  text: string;
  createdAt: number;
}

function toDTO(r: DirectMessageRecord): DirectMessageDTO {
  return { id: r.id, fromUserId: r.fromUserId, fromUsername: r.fromUsername, toUserId: r.toUserId, text: r.text, createdAt: r.createdAt };
}

/** Trim, collapse runs of whitespace, and cap length. */
function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DM_LEN);
}

export class DmService {
  // Real-time hook: notify the recipient of a new DM. Wired by the gateway (io-agnostic).
  private notifier: ((toUserId: string, dto: DirectMessageDTO) => void) | null = null;

  constructor(
    private readonly dms: DmRepository,
    private readonly friends: FriendsService,
    private readonly users: UserRepository,
  ) {}

  setNotifier(fn: (toUserId: string, dto: DirectMessageDTO) => void): void {
    this.notifier = fn;
  }

  /** Send a DM. Friends-only; returns null if not friends, the empty/blank, or sender unknown. */
  async send(fromUserId: string, toUserId: string, rawText: string): Promise<DirectMessageDTO | null> {
    if (fromUserId === toUserId) return null;
    const text = sanitize(rawText);
    if (!text) return null;
    if (!(await this.friends.areFriends(fromUserId, toUserId))) return null;
    const me = await this.users.findById(fromUserId);
    if (!me) return null;
    const rec = await this.dms.add({ fromUserId, fromUsername: me.username, toUserId, text });
    const dto = toDTO(rec);
    try { this.notifier?.(toUserId, dto); } catch { /* real-time is best-effort */ }
    return dto;
  }

  /** The conversation with `other`, marking the caller's side read. Friends-only. */
  async conversation(caller: string, other: string, now: number, limit = 50): Promise<DirectMessageDTO[] | null> {
    if (!(await this.friends.areFriends(caller, other))) return null;
    const rows = await this.dms.conversation(caller, other, limit);
    await this.dms.markRead(caller, other, now).catch(() => undefined); // opening reads it
    return rows.map(toDTO);
  }

  /** Per-friend unread counts for the caller (for badges). Filtered to CURRENT friends so a
   *  sender you've since unfriended/blocked doesn't linger as a badge (and isn't disclosed). */
  async unread(caller: string): Promise<Record<string, number>> {
    const all = await this.dms.unreadByFrom(caller);
    const checked = await Promise.all(
      Object.entries(all).map(async ([from, n]) =>
        ((await this.friends.areFriends(caller, from)) ? ([from, n] as const) : null)),
    );
    return Object.fromEntries(checked.filter((e): e is readonly [string, number] => e !== null));
  }
}
