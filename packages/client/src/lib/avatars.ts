// Cosmetic preset avatars — must match the server's AVATARS set (profileService).
export const AVATARS = [
  'spade', 'heart', 'club', 'diamond', 'crown', 'star',
  'lion', 'dragon', 'knight', 'joker', 'cherry', 'skull',
] as const;
export type AvatarId = (typeof AVATARS)[number];

const EMOJI: Record<string, string> = {
  spade: '♠️', heart: '♥️', club: '♣️', diamond: '♦️', crown: '👑', star: '⭐',
  lion: '🦁', dragon: '🐉', knight: '🛡️', joker: '🃏', cherry: '🍒', skull: '💀',
};

export function avatarEmoji(id: string | null | undefined): string {
  return (id && EMOJI[id]) || '🎴';
}
