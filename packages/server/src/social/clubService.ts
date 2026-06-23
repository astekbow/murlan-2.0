// ============================================================================
// MURLAN — Club service (membership lifecycle)
// ----------------------------------------------------------------------------
// Create / join / leave / list clubs. A player is in at most one club. When the
// founder leaves, the oldest remaining member is promoted; an emptied club is
// deleted. Pure social — no money/scoring. Member rows are enriched with the
// player's public username/avatar for display.
// ============================================================================

import type { ClubDetailDTO, ClubSummaryDTO, ClubMemberDTO, ClubRoleDTO } from '@murlan/shared';
import type { UserRepository } from '../auth/userRepository.ts';
import { type ClubRepository, type Club, DuplicateClubTagError, MAX_CLUB_MEMBERS } from './clubRepository.ts';

export class ClubError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ClubError'; }
}

const NAME_RE = /^[\p{L}\p{N} '._-]{3,32}$/u;
const TAG_RE = /^[A-Za-z0-9]{2,5}$/;

export class ClubService {
  constructor(
    private readonly clubs: ClubRepository,
    private readonly users: UserRepository,
  ) {}

  private summary(c: Club, memberCount: number): ClubSummaryDTO {
    return { id: c.id, name: c.name, tag: c.tag, founderId: c.founderId, createdAt: c.createdAt, memberCount };
  }

  /** Build the detail DTO. `isMember` controls whether the private joinCode is exposed —
   *  it is a member-only secret (authz-4). The member roster is paginated + the per-member
   *  user lookups are BATCHED via findManyByIds (no N+1 — dos-1). */
  private async detail(c: Club, isMember: boolean): Promise<ClubDetailDTO> {
    const total = await this.clubs.countMembers(c.id);
    const rows = await this.clubs.listMembers(c.id, MAX_CLUB_MEMBERS);
    const users = await this.users.findManyByIds(rows.map((m) => m.userId)).catch(() => []);
    const byId = new Map(users.map((u) => [u.id, u]));
    const members: ClubMemberDTO[] = rows.map((m) => {
      const u = byId.get(m.userId);
      return { userId: m.userId, username: u?.username ?? '—', avatar: u?.avatar ?? null, role: m.role as ClubRoleDTO };
    });
    // Never expose the share code to a non-member (anyone with the club id could
    // otherwise read it and joinByCode a private club they were not invited to).
    return { ...this.summary(c, total), members, private: c.private, joinCode: isMember ? c.joinCode : null };
  }

  /** Is this user a member of this specific club? (cheap single-row membership lookup) */
  private async isMemberOf(userId: string | undefined, clubId: string): Promise<boolean> {
    if (!userId) return false;
    const m = await this.clubs.memberOf(userId);
    return !!m && m.clubId === clubId;
  }

  async listClubs(): Promise<ClubSummaryDTO[]> {
    const rows = await this.clubs.listClubs(100);
    return rows.map((r) => this.summary(r, r.memberCount));
  }

  /** Club detail. `callerUserId` (when provided) is reconciled against membership:
   *  a PRIVATE club is 404'd for a non-member (authz-4), and the joinCode is only
   *  rendered to members. A public club is visible to anyone, joinCode withheld. */
  async getClub(id: string, callerUserId?: string): Promise<ClubDetailDTO | null> {
    const c = await this.clubs.getClub(id);
    if (!c) return null;
    const member = await this.isMemberOf(callerUserId, id);
    // A private club does not exist for a non-member (don't even confirm its presence).
    if (c.private && !member) return null;
    return this.detail(c, member);
  }

  async getMyClub(userId: string): Promise<ClubDetailDTO | null> {
    const m = await this.clubs.memberOf(userId);
    if (!m) return null;
    const c = await this.clubs.getClub(m.clubId);
    return c ? this.detail(c, true) : null; // the caller is, by definition, a member
  }

  async create(userId: string, name: string, tag: string, priv = false): Promise<ClubDetailDTO> {
    if (await this.clubs.memberOf(userId)) throw new ClubError('already_in_club', 'Je tashmë në një klub.');
    const trimmed = name.trim();
    if (!NAME_RE.test(trimmed)) throw new ClubError('bad_name', 'Emër klubi i pavlefshëm (3–32 shkronja).');
    if (!TAG_RE.test(tag)) throw new ClubError('bad_tag', 'Etiketë e pavlefshme (2–5 shkronja/numra).');
    try {
      const c = await this.clubs.createClub({ name: trimmed, tag: tag.toUpperCase(), founderId: userId, private: priv });
      return this.detail(c, true); // founder is a member
    } catch (e) {
      if (e instanceof DuplicateClubTagError) throw new ClubError('tag_taken', 'Kjo etiketë është e zënë.');
      throw e;
    }
  }

  async join(userId: string, clubId: string): Promise<ClubDetailDTO> {
    if (await this.clubs.memberOf(userId)) throw new ClubError('already_in_club', 'Je tashmë në një klub.');
    const c = await this.clubs.getClub(clubId);
    if (!c) throw new ClubError('no_club', 'Klubi nuk ekziston.');
    // A private club can't be joined by id from the public path — only by its code.
    if (c.private) throw new ClubError('no_club', 'Klubi nuk ekziston.');
    if (await this.clubs.countMembers(clubId) >= MAX_CLUB_MEMBERS) throw new ClubError('club_full', 'Klubi është plot.');
    await this.clubs.addMember({ userId, clubId, role: 'member' });
    return this.detail(c, true); // the caller just joined → a member
  }

  /** Join a PRIVATE club by its share code. */
  async joinByCode(userId: string, code: string): Promise<ClubDetailDTO> {
    if (await this.clubs.memberOf(userId)) throw new ClubError('already_in_club', 'Je tashmë në një klub.');
    const c = await this.clubs.getByCode(code);
    if (!c) throw new ClubError('no_club', 'Kodi i klubit nuk u gjet.');
    if (await this.clubs.countMembers(c.id) >= MAX_CLUB_MEMBERS) throw new ClubError('club_full', 'Klubi është plot.');
    await this.clubs.addMember({ userId, clubId: c.id, role: 'member' });
    return this.detail(c, true); // the caller just joined → a member
  }

  /** Leave the current club. Empties the club → delete it; founder leaves with
   *  members remaining → promote the oldest remaining member to founder. */
  async leave(userId: string): Promise<{ ok: boolean }> {
    const m = await this.clubs.memberOf(userId);
    if (!m) throw new ClubError('not_in_club', 'Nuk je në një klub.');
    const wasFounder = m.role === 'founder';
    await this.clubs.removeMember(userId);
    const remaining = await this.clubs.listMembers(m.clubId);
    if (remaining.length === 0) {
      await this.clubs.deleteClub(m.clubId);
    } else if (wasFounder) {
      const heir = remaining[0]!; // listMembers is ordered by join time among non-founders now
      await this.clubs.setRole(heir.userId, 'founder');
      await this.clubs.setFounder(m.clubId, heir.userId);
    }
    return { ok: true };
  }
}
