// ============================================================================
// MURLAN — Support / dispute ticket store
// ----------------------------------------------------------------------------
// Players open tickets (optionally referencing a match for a dispute); admins
// resolve them with a note (also written to the immutable AdminAction audit
// trail by the route). Interface + in-memory impl (Prisma impl mirrors it).
// ============================================================================

export type SupportStatus = 'open' | 'resolved' | 'closed';
export type SupportCategory = 'match' | 'payment' | 'account' | 'other';
export const SUPPORT_CATEGORIES: readonly SupportCategory[] = ['match', 'payment', 'account', 'other'];

export interface SupportTicket {
  id: string;
  userId: string;
  category: SupportCategory;
  subject: string;
  message: string;
  status: SupportStatus;
  matchId: string | null;
  adminNote: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface NewSupportTicket {
  userId: string;
  category: SupportCategory;
  subject: string;
  message: string;
  matchId?: string | null;
}

export interface SupportRepository {
  create(t: NewSupportTicket): Promise<SupportTicket>;
  get(id: string): Promise<SupportTicket | null>;
  listByUser(userId: string): Promise<SupportTicket[]>; // newest first
  list(limit: number): Promise<SupportTicket[]>;        // admin triage, newest first
  /** Resolve/close a ticket with an admin note. Returns null if not found. */
  resolve(id: string, status: 'resolved' | 'closed', adminNote: string | null, atMs: number): Promise<SupportTicket | null>;
}

export class InMemorySupportRepository implements SupportRepository {
  private byId = new Map<string, SupportTicket>();
  private seq = 0;

  async create(t: NewSupportTicket): Promise<SupportTicket> {
    this.seq += 1;
    const ticket: SupportTicket = {
      id: `ticket_${this.seq}`,
      userId: t.userId,
      category: t.category,
      subject: t.subject,
      message: t.message,
      status: 'open',
      matchId: t.matchId ?? null,
      adminNote: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.byId.set(ticket.id, ticket);
    return { ...ticket };
  }

  async get(id: string): Promise<SupportTicket | null> {
    const t = this.byId.get(id);
    return t ? { ...t } : null;
  }

  async listByUser(userId: string): Promise<SupportTicket[]> {
    return [...this.byId.values()].filter((t) => t.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map((t) => ({ ...t }));
  }

  async list(limit: number): Promise<SupportTicket[]> {
    return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(0, limit)).map((t) => ({ ...t }));
  }

  async resolve(id: string, status: 'resolved' | 'closed', adminNote: string | null, atMs: number): Promise<SupportTicket | null> {
    const t = this.byId.get(id);
    if (!t) return null;
    t.status = status;
    t.adminNote = adminNote;
    t.resolvedAt = atMs;
    return { ...t };
  }
}
