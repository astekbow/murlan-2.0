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
 * Resize an image File to a small square thumbnail (cover-cropped) and return it as a JPEG data URL —
 * kept tiny so it can be stored inline on the profile without bloating leaderboards/seats.
 *
 * Rejects with a SPECIFIC code so the caller can show an actionable message:
 *   'avatar_unsupported' (not an image) · 'avatar_decode' (unreadable / format the browser can't decode,
 *   e.g. HEIC on some browsers) · 'avatar_canvas' · 'avatar_encode'.
 *
 * Decoding goes through createImageBitmap first: it handles large phone photos FAR more reliably than the
 * <img> path (lower memory, no full-res raster), which is the usual reason an upload silently failed on
 * iOS. Falls back to <img> where createImageBitmap is missing or rejects.
 */
export async function imageToAvatarDataUrl(file: File, size = 64): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('avatar_unsupported');

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('avatar_canvas');

  let bitmap: ImageBitmap | null = null;
  let src: CanvasImageSource;
  let sw: number;
  let sh: number;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
      src = bitmap;
      sw = bitmap.width;
      sh = bitmap.height;
    } else {
      const img = await loadImageElement(file);
      src = img;
      sw = img.naturalWidth;
      sh = img.naturalHeight;
    }
  } catch {
    // createImageBitmap can reject on a format the engine can't decode — retry the <img> path once.
    try {
      const img = await loadImageElement(file);
      src = img;
      sw = img.naturalWidth;
      sh = img.naturalHeight;
    } catch {
      throw new Error('avatar_decode');
    }
  }
  if (!sw || !sh) throw new Error('avatar_decode');

  const scale = Math.max(size / sw, size / sh); // cover-crop to a centered square
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
  bitmap?.close();

  let out: string;
  try {
    // Some browsers without JPEG encoding silently fall back to PNG — fine, the server accepts png too.
    out = canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    throw new Error('avatar_encode');
  }
  if (!out || out.length < 32) throw new Error('avatar_encode');
  return out;
}

/** <img>-element decode fallback for browsers without (or that reject) createImageBitmap. */
function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('avatar_decode')); };
    img.src = url;
  });
}
