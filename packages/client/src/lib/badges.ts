// Profile badges — derived PURELY from a player's public stats (no server change,
// no storage). Decorative status markers shown on the profile. Cosmetic only.
import type { Profile } from './api.ts';
import { translate, useLangStore } from './i18n.ts';

export interface Badge {
  id: string;
  icon: string;
  name: string;  // resolved to the UI language at call time
  desc: string;
}

interface BadgeDef {
  id: string;
  icon: string;
  nameKey: string;
  descKey: string;
  earned: (p: Profile) => boolean;
}

// Ordered most-prestigious first so the most impressive badges lead the row.
const DEFS: BadgeDef[] = [
  { id: 'elite', icon: '👑', nameKey: 'badge.eliteName', descKey: 'badge.eliteDesc', earned: (p) => p.level >= 10 },
  { id: 'master', icon: '🏅', nameKey: 'badge.masterName', descKey: 'badge.masterDesc', earned: (p) => p.wins >= 50 },
  { id: 'veteran', icon: '🎖️', nameKey: 'badge.veteranName', descKey: 'badge.veteranDesc', earned: (p) => p.gamesPlayed >= 100 },
  { id: 'bigpot', icon: '💰', nameKey: 'badge.bigpotName', descKey: 'badge.bigpotDesc', earned: (p) => p.biggestPotCents >= 10_000 },
  { id: 'streak', icon: '🔥', nameKey: 'badge.streakName', descKey: 'badge.streakDesc', earned: (p) => p.currentStreak >= 5 },
  { id: 'consistent', icon: '📈', nameKey: 'badge.consistentName', descKey: 'badge.consistentDesc', earned: (p) => p.gamesPlayed >= 20 && p.winRate >= 0.6 },
  { id: 'winner', icon: '⭐', nameKey: 'badge.winnerName', descKey: 'badge.winnerDesc', earned: (p) => p.wins >= 10 },
];

/** The badges a profile has earned (most prestigious first), labels in the UI language. */
export function earnedBadges(p: Profile): Badge[] {
  const lang = useLangStore.getState().lang;
  return DEFS.filter((d) => d.earned(p)).map((d) => ({
    id: d.id, icon: d.icon, name: translate(d.nameKey, lang), desc: translate(d.descKey, lang),
  }));
}
