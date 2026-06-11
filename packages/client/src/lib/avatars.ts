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

/** True when the avatar is an UPLOADED image (stored inline as a data URL) rather
 *  than a preset emoji id — render it as an <img> instead of text. */
export function isImageAvatar(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith('data:image/');
}

/**
 * Resize an image File to a small square thumbnail (cover-cropped) and return it
 * as a JPEG data URL — kept tiny so it can be stored inline on the profile without
 * bloating leaderboards/seats.
 */
export function imageToAvatarDataUrl(file: File, size = 64): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('no canvas'));
      const scale = Math.max(size / img.width, size / img.height); // cover
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load failed')); };
    img.src = url;
  });
}
