// ============================================================================
// MURLAN — Clubs persistence (membership foundation)
// ----------------------------------------------------------------------------
// A player belongs to at most ONE club (membership is keyed by userId). createClub
// also seats the founder. Interface + in-memory impl (Prisma mirrors it).
// ============================================================================

export type ClubRole = 'founder' | 'member';

export interface Club {
  id: string;
  name: string;
  tag: string;
  founderId: string;
  createdAt: number;
}

export interface ClubMember {
  userId: string;
  clubId: string;
  role: ClubRole;
  joinedAt: number;
}

export interface NewClub {
  name: string;
  tag: string;
  founderId: string;
}

/** Thrown when a club tag collides (unique). */
export class DuplicateClubTagError extends Error {
  constructor() { super('club tag already exists'); this.name = 'DuplicateClubTagError'; }
}

export interface ClubRepository {
  /** Create a club AND seat its founder (role 'founder') atomically. */
  createClub(c: NewClub): Promise<Club>;
  getClub(id: string): Promise<Club | null>;
  getByTag(tag: string): Promise<Club | null>;
  listClubs(limit: number): Promise<Array<Club & { memberCount: number }>>;
  deleteClub(id: string): Promise<void>;
  setFounder(clubId: string, founderId: string): Promise<void>;
  memberOf(userId: string): Promise<ClubMember | null>;
  addMember(m: { userId: string; clubId: string; role: ClubRole }): Promise<ClubMember>;
  removeMember(userId: string): Promise<void>;
  setRole(userId: string, role: ClubRole): Promise<void>;
  /** Members of a club — founder first, then by join time. */
  listMembers(clubId: string): Promise<ClubMember[]>;
}

export class InMemoryClubRepository implements ClubRepository {
  private clubs = new Map<string, Club>();
  private members = new Map<string, ClubMember>(); // keyed by userId (one club per user)
  private seq = 0;

  async createClub(c: NewClub): Promise<Club> {
    const tag = c.tag.toUpperCase();
    for (const cl of this.clubs.values()) if (cl.tag === tag) throw new DuplicateClubTagError();
    this.seq += 1;
    const club: Club = { id: `club_${this.seq}`, name: c.name, tag, founderId: c.founderId, createdAt: Date.now() };
    this.clubs.set(club.id, club);
    this.members.set(c.founderId, { userId: c.founderId, clubId: club.id, role: 'founder', joinedAt: Date.now() });
    return { ...club };
  }
  async getClub(id: string): Promise<Club | null> {
    const c = this.clubs.get(id);
    return c ? { ...c } : null;
  }
  async getByTag(tag: string): Promise<Club | null> {
    const up = tag.toUpperCase();
    for (const c of this.clubs.values()) if (c.tag === up) return { ...c };
    return null;
  }
  async listClubs(limit: number): Promise<Array<Club & { memberCount: number }>> {
    const counts = new Map<string, number>();
    for (const m of this.members.values()) counts.set(m.clubId, (counts.get(m.clubId) ?? 0) + 1);
    return [...this.clubs.values()]
      .map((c) => ({ ...c, memberCount: counts.get(c.id) ?? 0 }))
      .sort((a, b) => b.memberCount - a.memberCount || b.createdAt - a.createdAt)
      .slice(0, Math.max(0, limit));
  }
  async deleteClub(id: string): Promise<void> {
    this.clubs.delete(id);
    for (const [uid, m] of this.members) if (m.clubId === id) this.members.delete(uid);
  }
  async setFounder(clubId: string, founderId: string): Promise<void> {
    const c = this.clubs.get(clubId);
    if (c) c.founderId = founderId;
  }
  async memberOf(userId: string): Promise<ClubMember | null> {
    const m = this.members.get(userId);
    return m ? { ...m } : null;
  }
  async addMember(m: { userId: string; clubId: string; role: ClubRole }): Promise<ClubMember> {
    if (this.members.has(m.userId)) throw new Error('already in a club');
    const row: ClubMember = { userId: m.userId, clubId: m.clubId, role: m.role, joinedAt: Date.now() };
    this.members.set(m.userId, row);
    return { ...row };
  }
  async removeMember(userId: string): Promise<void> {
    this.members.delete(userId);
  }
  async setRole(userId: string, role: ClubRole): Promise<void> {
    const m = this.members.get(userId);
    if (m) m.role = role;
  }
  async listMembers(clubId: string): Promise<ClubMember[]> {
    return [...this.members.values()]
      .filter((m) => m.clubId === clubId)
      .sort((a, b) => (a.role === 'founder' ? -1 : b.role === 'founder' ? 1 : 0) || a.joinedAt - b.joinedAt)
      .map((m) => ({ ...m }));
  }
}
