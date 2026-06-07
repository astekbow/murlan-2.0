// Clubs: if you're in one, see it (members + roles) and leave; otherwise browse
// clubs to join, or create your own. One club per player.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { clubsApi, ApiError, type ClubSummaryDTO, type ClubDetailDTO, type ChatMessageDTO } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { avatarEmoji } from '../lib/avatars.ts';
import { useT } from '../lib/i18n.ts';

export function ClubsView() {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const [mine, setMine] = useState<ClubDetailDTO | null>(null);
  const [list, setList] = useState<ClubSummaryDTO[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [priv, setPriv] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [busy, setBusy] = useState(false);

  const token = () => useAuthStore.getState().accessToken;

  async function load() {
    const tk = token();
    if (!tk) { setStatus('error'); setError(t('clubs.signInToView')); return; }
    try {
      const [m, l] = await Promise.all([clubsApi.mine(tk), clubsApi.list(tk)]);
      setMine(m.club);
      setList(l.clubs);
      setStatus('ready');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('clubs.errLoad'));
      setStatus('error');
    }
  }
  useEffect(() => { void load(); }, []);

  const act = async (fn: () => Promise<unknown>) => {
    const tk = token();
    if (!tk || busy) return;
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : t('clubs.actionFailed')); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('clubs.community')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('clubs.clubs')}</h1>
        </div>
        <span className="text-4xl opacity-80">🛡️</span>
      </section>

      {status === 'loading' ? (
        <div className="panel p-10 text-center"><div className="text-4xl mb-2 opacity-60 animate-pulse">🛡️</div><p className="text-sm text-muted">{t('clubs.loading')}</p></div>
      ) : mine ? (
        <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.05s' }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-lg">[{mine.tag}] {mine.name}</h2>
            <button disabled={busy} onClick={() => void act(() => clubsApi.leave(token()!))} className="btn btn-danger">{t('clubs.leaveClub')}</button>
          </div>
          <div className="text-xs text-muted">{t('clubs.memberCount', { n: mine.memberCount })}</div>
          {mine.private && mine.joinCode && (
            <div className="rounded-xl px-4 py-3 border border-gold/40 bg-gold/[.06] text-center">
              <div className="text-[11px] uppercase tracking-wider text-muted/70 mb-0.5">{t('clubs.shareCode')}</div>
              <button
                onClick={() => { void navigator.clipboard?.writeText(mine.joinCode!).catch(() => {}); }}
                className="font-mono text-2xl tracking-[0.35em] gold-text font-bold"
                title={t('clubs.shareCodeHint')}
              >
                {mine.joinCode}
              </button>
            </div>
          )}
          <ul className="space-y-2">
            {mine.members.map((m) => (
              <li key={m.userId} className="flex items-center gap-3 rounded-xl px-4 py-2.5 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                <span className="pfp shrink-0" style={{ width: 40, height: 40 }}><span className="text-lg leading-none">{avatarEmoji(m.avatar)}</span></span>
                <span className="font-display font-semibold tracking-wide text-txt flex-1 truncate">{m.username}</span>
                {m.role === 'founder' && <span className="tag tag-open">{t('clubs.founder')}</span>}
              </li>
            ))}
          </ul>
          {error && <p className="text-xs text-red-300">{error}</p>}
        </section>
      ) : null}

      {mine && <ClubChat club={mine} />}

      {!mine && status !== 'loading' && (
        <>
          <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.05s' }}>
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('clubs.createClub')}</h2>
            <div className="flex flex-wrap gap-3 items-end">
              <label className="block flex-1 min-w-[160px]"><span className="field-label">{t('clubs.nameLabel')}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Murlan Masters" className="field" /></label>
              <label className="block"><span className="field-label">{t('clubs.tagLabel')}</span>
                <input value={tag} onChange={(e) => setTag(e.target.value.toUpperCase().slice(0, 5))} maxLength={5} placeholder="MUR" className="field w-24 uppercase font-mono" /></label>
              <button disabled={busy || name.trim().length < 3 || tag.trim().length < 2} onClick={() => void act(() => clubsApi.create(token()!, name.trim(), tag.trim(), priv))} className="btn btn-gold">{t('clubs.create')}</button>
            </div>
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="w-4 h-4 accent-gold" />
              <span className="text-sm text-txt">{t('clubs.privateClub')}</span>
              <span className="text-[11px] text-muted/70">{t('clubs.privateHint')}</span>
            </label>
            {error && <p className="text-xs text-red-300">{error}</p>}
          </section>

          {/* Join a PRIVATE club by its share code */}
          <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('clubs.joinByCodeTitle')}</h2>
            <div className="flex items-center gap-2">
              <input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                maxLength={6}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('clubs.codePlaceholder')}
                className="field flex-1 tracking-[0.3em] font-mono uppercase"
              />
              <button disabled={busy || codeInput.trim().length < 4} onClick={() => void act(() => clubsApi.joinByCode(token()!, codeInput.trim()))} className="btn btn-ghost shrink-0">{t('clubs.join')}</button>
            </div>
          </section>

          <section className="panel p-5 animate-rise" style={{ animationDelay: '.1s' }}>
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('clubs.clubs')}</h2>
            {list.length === 0 ? (
              <p className="text-sm text-muted text-center py-6">{t('clubs.empty')}</p>
            ) : (
              <ul className="space-y-2.5">
                {list.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold transition-all">
                    <span className="font-display font-semibold tracking-wide text-gold-hi shrink-0">[{c.tag}]</span>
                    <span className="font-display font-semibold tracking-wide text-txt flex-1 truncate">{c.name}</span>
                    <span className="text-xs text-muted">{c.memberCount} 👥</span>
                    <button disabled={busy} onClick={() => void act(() => clubsApi.join(token()!, c.id))} className="btn btn-ghost">{t('clubs.join')}</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---- Club chat panel -------------------------------------------------------
// Members-only channel. Seeds history (REST) on mount, then live-appends via the
// socket store. Every message carries a Report button; the founder also gets a
// Mute button next to other members. Safety controls (report + founder mute) ship
// WITH the chat — moderation policy review is still required before broad rollout.
function ClubChat({ club }: { club: ClubDetailDTO }) {
  const t = useT();
  const messages = useGameStore((s) => s.clubChat);
  const sendClubMessage = useGameStore((s) => s.sendClubMessage);
  const setClubChat = useGameStore((s) => s.setClubChat);
  const myId = useAuthStore((s) => s.user?.id ?? null);
  const token = () => useAuthStore.getState().accessToken;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isFounder = club.members.find((m) => m.userId === myId)?.role === 'founder';

  // Seed history once for this club; live messages append via the store handler.
  useEffect(() => {
    const tk = token();
    if (!tk) return;
    clubsApi.messages(tk, club.id).then((r) => setClubChat(r.messages)).catch(() => setClubChat([]));
  }, [club.id, setClubChat]);

  // Keep the view pinned to the newest message.
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages.length]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const tx = text.trim();
    if (!tx || busy) return;
    setBusy(true);
    const ok = await sendClubMessage(tx);
    setBusy(false);
    if (ok) setText('');
  };

  const report = async (messageId: string) => {
    const tk = token();
    if (!tk) return;
    const reason = window.prompt(t('clubs.reportPrompt'))?.trim();
    if (!reason) return;
    await clubsApi.report(tk, messageId, reason).then(() => useGameStore.setState({ toast: t('clubs.reportSuccess'), toastKind: 'success' })).catch(() => useGameStore.setState({ toast: t('clubs.reportFailed'), toastKind: 'error' }));
  };

  const mute = async (userId: string) => {
    const tk = token();
    if (!tk) return;
    await clubsApi.mute(tk, userId).then(() => useGameStore.setState({ toast: t('clubs.muteSuccess'), toastKind: 'success' })).catch(() => useGameStore.setState({ toast: t('clubs.muteFailed'), toastKind: 'error' }));
  };

  return (
    <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.1s' }}>
      <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('clubs.chatTitle')}</h2>
      <div ref={scrollRef} className="max-h-[40vh] overflow-y-auto space-y-2 pr-1">
        {messages.length === 0 ? (
          <p className="text-sm text-muted text-center py-6">{t('clubs.chatEmpty')}</p>
        ) : messages.map((m: ChatMessageDTO) => (
          <div key={m.id} className="group flex items-start gap-2 rounded-xl px-3 py-2 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-display font-semibold tracking-wide text-gold-hi text-sm truncate">{m.username}</span>
                {m.userId === myId && <span className="text-[10px] text-muted">{t('clubs.you')}</span>}
              </div>
              <p className="text-sm text-txt break-words">{m.text}</p>
            </div>
            <div className="flex flex-col items-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
              {m.userId !== myId && <button onClick={() => void report(m.id)} className="text-[10px] text-muted hover:text-red-300" title={t('clubs.report')}>⚑</button>}
              {isFounder && m.userId !== myId && <button onClick={() => void mute(m.userId)} className="text-[10px] text-muted hover:text-gold-hi" title={t('clubs.mute')}>🔇</button>}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={280} placeholder={t('clubs.messagePlaceholder')} className="field flex-1" />
        <button type="submit" disabled={busy || !text.trim()} className="btn btn-gold">{t('clubs.send')}</button>
      </form>
    </section>
  );
}
