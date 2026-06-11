import { avatarEmoji, isImageAvatar } from '../../lib/avatars.ts';

interface AvatarFaceProps {
  id: string | null | undefined;
  /** Use inside a sized, position:relative wrapper (e.g. .pfp) — the image fills it. */
  fill?: boolean;
  /** Standalone size (px) when NOT inside a .pfp wrapper. */
  size?: number;
  className?: string;
}

/** Renders a player's avatar as an uploaded photo (data-URL) when present, else the
 *  preset emoji. Use everywhere avatars show so uploaded photos appear consistently. */
export function AvatarFace({ id, fill = false, size = 40, className = '' }: AvatarFaceProps) {
  if (isImageAvatar(id)) {
    if (fill) return <img src={id} alt="" className="pfp-img" />;
    return <img src={id} alt="" className={`rounded-full object-cover shrink-0 ${className}`} style={{ width: size, height: size }} />;
  }
  return <span className={className} aria-hidden>{avatarEmoji(id)}</span>;
}
