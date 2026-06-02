import { useEffect } from 'react';
import { useGameStore } from '../store/gameStore.ts';
import { sound } from '../lib/sound.ts';
import { useFocusTrap } from './ui/useFocusTrap.ts';

const EMOTES = ['👍', '😂', '😮', '😎', '🔥', '😢', '🤝', '👏', '🤔', '🍀', '🙈', '🎉'];
const PHRASES = ['Mirë luajtur!', 'Faleminderit', 'Hajde!', 'Shpejto pak 🙂', 'Fat të mirë 🍀', 'Oof…', 'Mbarsi!', 'Pa fjalë 😄'];

/** A small popover for in-game emotes / preset quick-chat (corner buttons). */
export function EmoteChat({ kind, onClose }: { kind: 'emote' | 'chat'; onClose: () => void }) {
  const sendEmote = useGameStore((s) => s.sendEmote);
  const sendChat = useGameStore((s) => s.sendChat);
  const trapRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (fn: () => void) => { sound.play('button'); fn(); onClose(); };

  return (
    <div className="fixed inset-0 z-[55] flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div
        ref={trapRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={kind === 'emote' ? 'Emote' : 'Bisedë e shpejtë'}
        className="panel-solid w-full max-w-sm p-4 animate-pop outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display font-semibold tracking-wide text-gold-hi text-sm">
            {kind === 'emote' ? 'EMOTE' : 'BISEDË E SHPEJTË'}
          </h3>
          <button className="iconbtn" onClick={onClose} aria-label="Mbyll">✕</button>
        </div>

        {kind === 'emote' ? (
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {EMOTES.map((e) => (
              <button key={e} onClick={() => pick(() => sendEmote(e))} className="text-2xl rounded-lg py-3 bg-white/[.04] border border-white/10 hover:border-gold active:scale-95">
                {e}
              </button>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {PHRASES.map((p) => (
              <button key={p} onClick={() => pick(() => sendChat(p))} className="btn btn-ghost text-left">
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
