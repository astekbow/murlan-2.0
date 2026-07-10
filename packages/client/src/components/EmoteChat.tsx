import { useEffect } from 'react';
import { useGameStore } from '../store/gameStore.ts';
import { sound } from '../lib/sound.ts';
import { useFocusTrap } from './ui/useFocusTrap.ts';
import { useT } from '../lib/i18n.ts';

const EMOTES = ['👍', '😂', '😮', '😎', '🔥', '😢', '🤝', '👏', '🤔', '🍀', '🙈', '🎉'];
// Quick-chat phrase keys — resolved with t() so each player sends in their own language.
const PHRASE_KEYS = ['emote.p1', 'emote.p2', 'emote.p3', 'emote.p4', 'emote.p5', 'emote.p6', 'emote.p7', 'emote.p8'] as const;

/** A small popover for in-game emotes / preset quick-chat (corner buttons). */
export function EmoteChat({ kind, onClose }: { kind: 'emote' | 'chat'; onClose: () => void }) {
  const t = useT();
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
        aria-label={kind === 'emote' ? t('emote.emote') : t('emote.quickChat')}
        className="panel-solid w-full max-w-sm p-4 animate-pop outline-none max-h-[88dvh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display font-semibold tracking-wide text-gold-hi text-sm">
            {kind === 'emote' ? t('emote.emoteTitle') : t('emote.quickChatTitle')}
          </h3>
          <button className="iconbtn" onClick={onClose} aria-label={t('common.close')}>✕</button>
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
            {PHRASE_KEYS.map((k) => {
              const phrase = t(k);
              return (
                <button key={k} onClick={() => pick(() => sendChat(phrase))} className="btn btn-ghost text-left">
                  {phrase}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
