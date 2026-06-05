// Storage for club chat: messages, abuse reports, and per-user mutes. Interface +
// in-memory impl (the Prisma impl mirrors it). Messages carry a denormalized
// username so history renders without a join. Mutes are global to chat (silence a
// user everywhere) and time-boxed.

export interface ChatMessageRecord {
  id: string;
  clubId: string;
  userId: string;
  username: string;
  text: string;
  createdAt: number;
}

export interface ChatReportRecord {
  id: string;
  messageId: string;
  clubId: string;
  reporterId: string;
  reason: string;
  createdAt: number;
  reviewed: boolean;
}

export interface ChatRepository {
  addMessage(m: { clubId: string; userId: string; username: string; text: string }): Promise<ChatMessageRecord>;
  getMessage(id: string): Promise<ChatMessageRecord | null>;
  /** Most-recent `limit` messages for a club, returned oldest→newest for display. */
  listByClub(clubId: string, limit: number): Promise<ChatMessageRecord[]>;
  addReport(r: { messageId: string; clubId: string; reporterId: string; reason: string }): Promise<void>;
  listReports(limit: number): Promise<ChatReportRecord[]>;
  /** Set a mute that lasts until `until` (epoch ms). */
  setMute(userId: string, until: number, by: string, reason: string): Promise<void>;
  clearMute(userId: string): Promise<void>;
  /** The mute expiry for a user, or null if not muted. */
  muteUntil(userId: string): Promise<number | null>;
}

export class InMemoryChatRepository implements ChatRepository {
  private messages: ChatMessageRecord[] = [];
  private reports: ChatReportRecord[] = [];
  private mutes = new Map<string, { until: number; by: string; reason: string }>();
  private seq = 0;

  async addMessage(m: { clubId: string; userId: string; username: string; text: string }): Promise<ChatMessageRecord> {
    const rec: ChatMessageRecord = { id: `msg_${(this.seq += 1)}`, ...m, createdAt: Date.now() };
    this.messages.push(rec);
    return { ...rec };
  }
  async getMessage(id: string): Promise<ChatMessageRecord | null> {
    const m = this.messages.find((x) => x.id === id);
    return m ? { ...m } : null;
  }
  async listByClub(clubId: string, limit: number): Promise<ChatMessageRecord[]> {
    return this.messages.filter((m) => m.clubId === clubId).slice(-Math.max(0, limit)).map((m) => ({ ...m }));
  }
  async addReport(r: { messageId: string; clubId: string; reporterId: string; reason: string }): Promise<void> {
    this.reports.push({ id: `rep_${(this.seq += 1)}`, ...r, createdAt: Date.now(), reviewed: false });
  }
  async listReports(limit: number): Promise<ChatReportRecord[]> {
    return this.reports.slice(-Math.max(0, limit)).reverse().map((r) => ({ ...r }));
  }
  async setMute(userId: string, until: number, by: string, reason: string): Promise<void> {
    this.mutes.set(userId, { until, by, reason });
  }
  async clearMute(userId: string): Promise<void> {
    this.mutes.delete(userId);
  }
  async muteUntil(userId: string): Promise<number | null> {
    return this.mutes.get(userId)?.until ?? null;
  }
}
