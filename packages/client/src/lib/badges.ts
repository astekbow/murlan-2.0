// Profile badges — display metadata for the SERVER-AWARDED badge ids carried on a
// profile (`profile.badges`). The server grants achievement badges when a stat
// threshold is crossed and season badges when a season is archived; here we only
// map an id → icon + localized name/desc for rendering. Cosmetic/status only.
import type { Profile } from './api.ts';
import { translate, useLangStore } from './i18n.ts';

export interface Badge {
  id: string;
  icon: string;
  name: string;  // resolved to the UI language at call time
  desc: string;
}

// Achievement badge ids ↔ icon + i18n keys. MUST stay in sync with the server
// ACHIEVEMENTS list (packages/server/src/rewards/achievements.ts). Ordered most
// prestigious LAST here, then reversed when rendering so the best lead the row.
interface AchievementMeta { id: string; icon: string; nameKey: string; descKey: string }
const ACHIEVEMENT_META: AchievementMeta[] = [
  { id: 'first_win',  icon: '🥇', nameKey: 'ach.firstWinName',  descKey: 'ach.firstWinDesc' },
  { id: 'wins_10',    icon: '🏅', nameKey: 'ach.wins10Name',    descKey: 'ach.wins10Desc' },
  { id: 'wins_100',   icon: '🏆', nameKey: 'ach.wins100Name',   descKey: 'ach.wins100Desc' },
  { id: 'games_1000', icon: '🎴', nameKey: 'ach.games1000Name', descKey: 'ach.games1000Desc' },
  { id: 'streak_5',   icon: '🔥', nameKey: 'ach.streak5Name',   descKey: 'ach.streak5Desc' },
  { id: 'streak_10',  icon: '⚡', nameKey: 'ach.streak10Name',  descKey: 'ach.streak10Desc' },
  { id: 'level_10',   icon: '⭐', nameKey: 'ach.level10Name',   descKey: 'ach.level10Desc' },
  { id: 'level_25',   icon: '🌟', nameKey: 'ach.level25Name',   descKey: 'ach.level25Desc' },
  { id: 'pot_100',    icon: '💰', nameKey: 'ach.pot100Name',    descKey: 'ach.pot100Desc' },
];
const ACH_BY_ID = new Map(ACHIEVEMENT_META.map((m) => [m.id, m]));
// Prestige order: the index in ACHIEVEMENT_META (later = more prestigious).
const ACH_RANK = new Map(ACHIEVEMENT_META.map((m, i) => [m.id, i]));

const SEASON_BADGE_RE = /^season_(\d+)_(finalist|top3|champion)$/;
const SEASON_KIND_META: Record<string, { icon: string; nameKey: string; descKey: string }> = {
  champion: { icon: '👑', nameKey: 'ach.seasonChampionName', descKey: 'ach.seasonChampionDesc' },
  top3:     { icon: '🥉', nameKey: 'ach.seasonTop3Name',     descKey: 'ach.seasonTop3Desc' },
  finalist: { icon: '🎗️', nameKey: 'ach.seasonFinalistName', descKey: 'ach.seasonFinalistDesc' },
};
const SEASON_KIND_RANK: Record<string, number> = { champion: 2, top3: 1, finalist: 0 };

/** Resolve one server badge id to its display metadata (null if the id is unknown). */
function resolveBadge(id: string, lang: 'sq' | 'en'): { badge: Badge; sort: number } | null {
  const ach = ACH_BY_ID.get(id);
  if (ach) {
    return {
      badge: { id, icon: ach.icon, name: translate(ach.nameKey, lang), desc: translate(ach.descKey, lang) },
      // Achievements sort ABOVE season badges; more-prestigious achievement first.
      sort: 1000 + (ACH_RANK.get(id) ?? 0),
    };
  }
  const m = SEASON_BADGE_RE.exec(id);
  if (m) {
    const number = Number(m[1]);
    const kind = m[2]!;
    const meta = SEASON_KIND_META[kind]!;
    const vars = { n: number };
    return {
      badge: { id, icon: meta.icon, name: translate(meta.nameKey, lang, vars), desc: translate(meta.descKey, lang, vars) },
      // Season badges sort below achievements; newer season + higher placement first.
      sort: number * 10 + (SEASON_KIND_RANK[kind] ?? 0),
    };
  }
  return null;
}

/** The badges a profile holds (most prestigious first), labels in the UI language. */
export function earnedBadges(p: Profile): Badge[] {
  const lang = useLangStore.getState().lang;
  const resolved = (p.badges ?? [])
    .map((id) => resolveBadge(id, lang))
    .filter((x): x is { badge: Badge; sort: number } => x !== null);
  resolved.sort((a, b) => b.sort - a.sort);
  return resolved.map((r) => r.badge);
}
