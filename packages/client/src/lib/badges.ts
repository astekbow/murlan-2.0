// Profile badges — derived PURELY from a player's public stats (no server change,
// no storage). Decorative status markers shown on the profile. Cosmetic only.
import type { Profile } from './api.ts';

export interface Badge {
  id: string;
  icon: string;
  name: string;  // Albanian, player-facing
  desc: string;
}

interface BadgeDef extends Badge {
  earned: (p: Profile) => boolean;
}

// Ordered most-prestigious first so the most impressive badges lead the row.
const DEFS: BadgeDef[] = [
  { id: 'elite', icon: '👑', name: 'Elitë', desc: 'Nivel 10+', earned: (p) => p.level >= 10 },
  { id: 'master', icon: '🏅', name: 'Mjeshtër', desc: '50+ fitore', earned: (p) => p.wins >= 50 },
  { id: 'veteran', icon: '🎖️', name: 'Veteran', desc: '100+ lojëra', earned: (p) => p.gamesPlayed >= 100 },
  { id: 'bigpot', icon: '💰', name: 'Pot i madh', desc: 'Fitoi $100+ në një pot', earned: (p) => p.biggestPotCents >= 10_000 },
  { id: 'streak', icon: '🔥', name: 'Seri zjarri', desc: '5+ fitore radhazi', earned: (p) => p.currentStreak >= 5 },
  { id: 'consistent', icon: '📈', name: 'Konsistent', desc: '60%+ fitore (20+ lojëra)', earned: (p) => p.gamesPlayed >= 20 && p.winRate >= 0.6 },
  { id: 'winner', icon: '⭐', name: 'Fitues', desc: '10+ fitore', earned: (p) => p.wins >= 10 },
];

/** The badges a profile has earned (most prestigious first). */
export function earnedBadges(p: Profile): Badge[] {
  return DEFS.filter((d) => d.earned(p)).map(({ earned: _earned, ...b }) => b);
}
