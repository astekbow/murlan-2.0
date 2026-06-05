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
import { type ClubRepository, type Club, DuplicateClubTagError } from './clubRepository.ts';

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

  private async detail(c: Club): Promise<ClubDetailDTO> {
    const rows = await this.clubs.listMembers(c.id);
    const members: ClubMemberDTO[] = await Promise.all(
      rows.map(async (m) => {
        const u = await this.users.findById(m.userId).catch(() => null);
        return { userId: m.userId, username: u?.username ?? '—', avatar: u?.avatar ?? null, role: m.role as ClubRoleDTO };
      }),
    );
    return { ...this.summary(c, rows.length), members };
  }

  async listClubs(): Promise<ClubSummaryDTO[]> {
    const rows = await this.clubs.listClubs(100);
    return rows.map((r) => this.summary(r, r.memberCount));
  }

  async getClub(id: string): Promise<ClubDetailDTO | null> {
    const c = await this.clubs.getClub(id);
    return c ? this.detail(c) : null;
  }

  async getMyClub(userId: string): Promise<ClubDetailDTO | null> {
    const m = await this.clubs.memberOf(userId);
    if (!m) return null;
    const c = await this.clubs.getClub(m.clubId);
    return c ? this.detail(c) : null;
  }

  async create(userId: string, name: string, tag: string): Promise<ClubDetailDTO> {
    if (await this.clubs.memberOf(userId)) throw new ClubError('already_in_club', 'Je tashmë në një klub.');
    const trimmed = name.trim();
    if (!NAME_RE.test(trimmed)) throw new ClubError('bad_name', 'Emër klubi i pavlefshëm (3–32 shkronja).');
    if (!TAG_RE.test(tag)) throw new ClubError('bad_tag', 'Etiketë e pavlefshme (2–5 shkronja/numra).');
    try {
      const c = await this.clubs.createClub({ name: trimmed, tag: tag.toUpperCase(), founderId: userId });
      return this.detail(c);
    } catch (e) {
      if (e instanceof DuplicateClubTagError) throw new ClubError('tag_taken', 'Kjo etiketë është e zënë.');
      throw e;
    }
  }

  async join(userId: string, clubId: string): Promise<ClubDetailDTO> {
    if (await this.clubs.memberOf(userId)) throw new ClubError('already_in_club', 'Je tashmë në një klub.');
    const c = await this.clubs.getClub(clubId);
    if (!c) throw new ClubError('no_club', 'Klubi nuk ekziston.');
    await this.clubs.addMember({ userId, clubId, role: 'member' });
    return this.detail(c);
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
