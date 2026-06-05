// ============================================================================
// MURLAN — Club chat service (with moderation foundation)
// ----------------------------------------------------------------------------
// Membership-gated club chat with the safety controls a real-money app needs from
// day one: server-side per-user MUTE (shadow), abuse REPORTS for admin review, a
// basic profanity/length sanitizer, and rate-limiting (enforced at the socket
// layer). Pure social — never touches money/scoring. NOTE: the profanity list is
// a minimal starter; production should review moderation POLICY (and likely a
// proper filter / human review SLA) before promoting chat widely.
// ============================================================================

import type { ChatMessageDTO } from '@murlan/shared';
import type { ClubService } from '../social/clubService.ts';
import type { ChatRepository, ChatMessageRecord, ChatReportRecord } from './chatRepository.ts';

const MAX_LEN = 280;
// Minimal starter blocklist (masked, not rejected). Intentionally small — real
// moderation is a policy decision, not a word list. Case-insensitive, word-ish.
const BLOCKLIST = ['fuck', 'shit', 'bitch', 'asshole'];

/** Trim, collapse whitespace, cap length, and mask blocklisted words. */
export function sanitizeChat(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  for (const word of BLOCKLIST) {
    text = text.replace(new RegExp(`\\b${word}\\b`, 'gi'), '*'.repeat(word.length));
  }
  return text;
}

const toDTO = (m: ChatMessageRecord): ChatMessageDTO => ({
  id: m.id, clubId: m.clubId, userId: m.userId, username: m.username, text: m.text, createdAt: m.createdAt,
});

export type SendResult =
  | { ok: true; message: ChatMessageDTO }
  | { ok: false; code: 'empty' | 'no_club' | 'muted' };

export class ChatService {
  constructor(
    private readonly repo: ChatRepository,
    private readonly clubs: ClubService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The club id a user belongs to (used to join their socket to the channel). */
  async clubIdFor(userId: string): Promise<string | null> {
    const club = await this.clubs.getMyClub(userId);
    return club?.id ?? null;
  }

  async isMuted(userId: string): Promise<boolean> {
    const until = await this.repo.muteUntil(userId);
    return until !== null && until > this.now();
  }

  /**
   * Send a message to the sender's OWN club (clubId derived from membership, never
   * client-supplied). A muted sender gets a `muted` result so the caller can
   * shadow-drop it (ack ok, no broadcast). Returns the persisted DTO on success.
   */
  async send(userId: string, username: string, rawText: string): Promise<SendResult> {
    const text = sanitizeChat(rawText);
    if (!text) return { ok: false, code: 'empty' };
    const club = await this.clubs.getMyClub(userId);
    if (!club) return { ok: false, code: 'no_club' };
    if (await this.isMuted(userId)) return { ok: false, code: 'muted' };
    const rec = await this.repo.addMessage({ clubId: club.id, userId, username, text });
    return { ok: true, message: toDTO(rec) };
  }

  /** Recent history for a club — members only (null if the caller isn't a member). */
  async history(userId: string, clubId: string, limit = 50): Promise<ChatMessageDTO[] | null> {
    const club = await this.clubs.getMyClub(userId);
    if (!club || club.id !== clubId) return null;
    return (await this.repo.listByClub(clubId, limit)).map(toDTO);
  }

  /** Report a message — only a member of the message's club may report it. */
  async report(userId: string, messageId: string, reason: string): Promise<{ ok: boolean; code?: string }> {
    const msg = await this.repo.getMessage(messageId);
    if (!msg) return { ok: false, code: 'not_found' };
    const club = await this.clubs.getMyClub(userId);
    if (!club || club.id !== msg.clubId) return { ok: false, code: 'forbidden' };
    await this.repo.addReport({ messageId, clubId: msg.clubId, reporterId: userId, reason: reason.slice(0, 280) });
    return { ok: true };
  }

  /** A club founder mutes a member of their OWN club. */
  async founderMute(callerId: string, targetUserId: string, durationMs: number, reason: string): Promise<{ ok: boolean; code?: string }> {
    const club = await this.clubs.getMyClub(callerId);
    if (!club) return { ok: false, code: 'no_club' };
    const isFounder = club.members.find((m) => m.userId === callerId)?.role === 'founder';
    if (!isFounder) return { ok: false, code: 'forbidden' };
    if (targetUserId === callerId) return { ok: false, code: 'self' };
    if (!club.members.some((m) => m.userId === targetUserId)) return { ok: false, code: 'not_member' };
    await this.repo.setMute(targetUserId, this.now() + durationMs, callerId, reason.slice(0, 280));
    return { ok: true };
  }

  /** Admin mute/unmute (global) + reports queue. */
  adminMute(targetUserId: string, durationMs: number, by: string, reason: string): Promise<void> {
    return this.repo.setMute(targetUserId, this.now() + durationMs, by, reason.slice(0, 280));
  }
  adminUnmute(targetUserId: string): Promise<void> {
    return this.repo.clearMute(targetUserId);
  }
  listReports(limit = 200): Promise<ChatReportRecord[]> {
    return this.repo.listReports(limit);
  }
}
