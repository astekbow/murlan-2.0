// Clubs: if you're in one, see it (members + roles) and leave; otherwise browse
// clubs to join, or create your own. One club per player.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { clubsApi, tournamentsApi, friendsApi, ApiError, type ClubSummaryDTO, type ClubDetailDTO, type ChatMessageDTO, type TournamentDTO, type FriendEntry } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { AvatarFace } from '../components/ui/AvatarFace.tsx';
import { ClubWarPanel } from '../components/ClubWarPanel.tsx';
import { SkeletonList } from '../components/ui/Skeleton.tsx';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { dollars } from '../lib/money.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

const tr = (key: string) => translate(key, useLangStore.getState().lang);

export function ClubsView() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
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
  const landscape = useLandscapePage();
  const [tab, setTab] = useState<'turne' | 'luftë' | 'chat'>('turne');
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);
  const myId = useAuthStore((s) => s.user?.id ?? null);
  // The caller founded this club → they may toggle its privacy + invite friends.
  const isFounder = !!mine && mine.members.find((m) => m.userId === myId)?.role === 'founder';

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

  // ---- Landscape "console": fixed-height, two-pane, no PAGE scroll (phone held flat).
  // Portaled to <body> so it escapes the ViewTransition's transform (which would otherwise
  // trap position:fixed inside <main>, leaving it under the TopBar) → true full-screen.
  if (landscape) {
    return createPortal(
      <div className="pg-ls">
        {dialog}
        <div className="pg-ls-top">
          <button onClick={() => setView('lobby')} className="btn btn-ghost btn-sm">← {t('common.backToLobby')}</button>
          <h1 className="pg-ls-title gold-text font-display font-bold tracking-wide truncate">
            {mine ? `[${mine.tag}] ${mine.name}` : t('clubs.clubs')}
          </h1>
          <span className="text-sm font-display font-semibold text-gold-hi shrink-0">{dollars(balanceCents)}</span>
        </div>

        {status === 'loading' ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4"><SkeletonList count={5} /></div></div>
        ) : mine ? (
          <div className="pg-ls-body">
            {/* LEFT — members + share code */}
            <div className="pg-ls-left panel p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs text-muted">{t('clubs.memberCount', { n: mine.memberCount })}</span>
                <button disabled={busy} onClick={async () => { if (await confirm({ title: t('clubs.leaveClub'), message: t('clubs.confirmLeaveM'), danger: true, confirmLabel: t('clubs.leaveClub') })) void act(() => clubsApi.leave(token()!)); }} className="btn btn-danger btn-sm">{t('clubs.leaveClub')}</button>
              </div>
              {isFounder && (
                <div className="flex items-center gap-1 mb-2" role="group" aria-label={t('clubs.privacy')}>
                  <button disabled={busy} aria-pressed={!mine.private} onClick={() => { if (mine.private) void act(() => clubsApi.setPrivacy(token()!, false)); }} className={`btn btn-sm flex-1 ${mine.private ? 'btn-ghost' : 'btn-gold'}`}>{t('clubs.makePublic')}</button>
                  <button disabled={busy} aria-pressed={mine.private} onClick={() => { if (!mine.private) void act(() => clubsApi.setPrivacy(token()!, true)); }} className={`btn btn-sm flex-1 ${mine.private ? 'btn-gold' : 'btn-ghost'}`}>{t('clubs.makePrivate')}</button>
                </div>
              )}
              {mine.private && mine.joinCode && (
                <button onClick={() => { void navigator.clipboard?.writeText(mine.joinCode!).then(() => useGameStore.setState({ toast: t('clubs.codeCopied'), toastKind: 'success' })).catch(() => {}); }} aria-label={t('common.copyCode')} className="w-full mb-2 rounded-lg px-3 py-1.5 border border-gold/40 bg-gold/[.06] font-mono tracking-[0.3em] gold-text font-bold text-sm">{mine.joinCode}</button>
              )}
              <InviteFriendsPanel compact />
              <ul className="pg-ls-scroll space-y-1.5 pr-1">
                {mine.members.map((m, i) => (
                  <li key={m.userId} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 border border-white/10 bg-white/[.03]">
                    <span className="text-xs font-mono text-muted/70 w-5 text-right shrink-0">{i + 1}</span>
                    <span className="pfp shrink-0" style={{ width: 28, height: 28 }}><AvatarFace id={m.avatar} fill className="text-sm leading-none" /></span>
                    <span className="font-display font-semibold text-txt text-sm flex-1 truncate">{m.username}</span>
                    {m.role === 'founder' && <span className="text-[11px]" title={t('clubs.founder')}>👑</span>}
                    <span className="text-[11px] text-muted shrink-0">{t('clubs.lvlWins', { lvl: m.level, wins: m.wins })}</span>
                  </li>
                ))}
              </ul>
            </div>
            {/* RIGHT — tabs: tournaments | chat */}
            <div className="pg-ls-right">
              <div className="pg-ls-tabs">
                <button className={`pg-ls-tab ${tab === 'turne' ? 'on' : ''}`} onClick={() => setTab('turne')}>{t('clubs.tournaments')}</button>
                <button className={`pg-ls-tab ${tab === 'luftë' ? 'on' : ''}`} onClick={() => setTab('luftë')} aria-label={t('clubs.warTab')}>⚔️ {t('clubs.warTab')}</button>
                <button className={`pg-ls-tab ${tab === 'chat' ? 'on' : ''}`} onClick={() => setTab('chat')}>{t('clubs.chatTitle')}</button>
              </div>
              <div className="pg-ls-scroll">
                {tab === 'turne' ? <ClubTournaments club={mine} /> : tab === 'luftë' ? <ClubWarPanel club={mine} /> : <ClubChat club={mine} />}
              </div>
            </div>
          </div>
        ) : (
          <div className="pg-ls-body">
            {/* LEFT — browse public clubs */}
            <div className="pg-ls-left panel p-3">
              <h2 className="text-sm font-display font-semibold text-gold-hi mb-2">{t('clubs.clubs')}</h2>
              <ul className="pg-ls-scroll space-y-1.5 pr-1">
                {list.length === 0 ? <p className="text-sm text-muted text-center py-6">{t('clubs.empty')}</p> : list.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 rounded-lg px-2.5 py-2 border border-white/10 bg-white/[.03]">
                    <span className="font-display font-semibold text-gold-hi text-sm shrink-0">[{c.tag}]</span>
                    <span className="font-display font-semibold text-txt text-sm flex-1 truncate">{c.name}</span>
                    <span className="text-[11px] text-muted">{c.memberCount}👥</span>
                    <button disabled={busy} onClick={() => void act(() => clubsApi.join(token()!, c.id))} className="btn btn-ghost btn-sm">{t('clubs.join')}</button>
                  </li>
                ))}
              </ul>
            </div>
            {/* RIGHT — create + join by code */}
            <div className="pg-ls-right pg-ls-scroll space-y-3">
              <section className="panel p-3 space-y-2">
                <h2 className="text-sm font-display font-semibold text-gold-hi">{t('clubs.createClub')}</h2>
                <form className="flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); if (busy || name.trim().length < 3 || tag.trim().length < 2) return; void act(() => clubsApi.create(token()!, name.trim(), tag.trim(), priv)); }}>
                  <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder={t('clubs.nameLabel')} className="field flex-1 min-w-[140px]" />
                  <input value={tag} onChange={(e) => setTag(e.target.value.toUpperCase().slice(0, 5))} maxLength={5} placeholder="MUR" className="field w-20 uppercase font-mono" />
                  <button type="submit" disabled={busy || name.trim().length < 3 || tag.trim().length < 2} className="btn btn-gold btn-sm">{t('clubs.create')}</button>
                </form>
                <label className="flex items-center gap-2 cursor-pointer select-none text-sm">
                  <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="w-4 h-4 accent-gold" />
                  <span className="text-txt">{t('clubs.privateClub')}</span>
                </label>
              </section>
              <section className="panel p-3 space-y-2">
                <h2 className="text-sm font-display font-semibold text-gold-hi">{t('clubs.joinByCodeTitle')}</h2>
                <div className="flex items-center gap-2">
                  <input value={codeInput} onChange={(e) => setCodeInput(e.target.value.toUpperCase())} maxLength={6} autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder={t('clubs.codePlaceholder')}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !busy && codeInput.trim().length >= 4) { e.preventDefault(); void act(() => clubsApi.joinByCode(token()!, codeInput.trim())); } }}
                    className="field flex-1 tracking-[0.3em] font-mono uppercase" />
                  <button disabled={busy || codeInput.trim().length < 4} onClick={() => void act(() => clubsApi.joinByCode(token()!, codeInput.trim()))} className="btn btn-ghost btn-sm shrink-0">{t('clubs.join')}</button>
                </div>
              </section>
              {error && <p className="text-xs text-red-300">{error}</p>}
            </div>
          </div>
        )}
      </div>,
      document.getElementById('root') ?? document.body,
    );
  }

  return (
    <div className="space-y-5">
      <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>
      {dialog}

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('clubs.community')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('clubs.clubs')}</h1>
        </div>
        <span className="text-4xl opacity-80">🛡️</span>
      </section>

      {status === 'loading' ? (
        <section className="panel p-5 animate-rise"><SkeletonList count={4} /></section>
      ) : mine ? (
        <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.05s' }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-lg">[{mine.tag}] {mine.name}</h2>
            <button disabled={busy} onClick={async () => { if (await confirm({ title: t('clubs.leaveClub'), message: t('clubs.confirmLeaveM'), danger: true, confirmLabel: t('clubs.leaveClub') })) void act(() => clubsApi.leave(token()!)); }} className="btn btn-danger">{t('clubs.leaveClub')}</button>
          </div>
          <div className="text-xs text-muted">{t('clubs.memberCount', { n: mine.memberCount })}</div>
          {isFounder && (
            <div className="flex items-center gap-2" role="group" aria-label={t('clubs.privacy')}>
              <span className="text-xs text-muted shrink-0">{t('clubs.privacy')}</span>
              <button disabled={busy} aria-pressed={!mine.private} onClick={() => { if (mine.private) void act(() => clubsApi.setPrivacy(token()!, false)); }} className={`btn btn-sm ${mine.private ? 'btn-ghost' : 'btn-gold'}`}>{t('clubs.makePublic')}</button>
              <button disabled={busy} aria-pressed={mine.private} onClick={() => { if (!mine.private) void act(() => clubsApi.setPrivacy(token()!, true)); }} className={`btn btn-sm ${mine.private ? 'btn-gold' : 'btn-ghost'}`}>{t('clubs.makePrivate')}</button>
            </div>
          )}
          {mine.private && mine.joinCode && (
            <div className="rounded-xl px-4 py-3 border border-gold/40 bg-gold/[.06] text-center">
              <div className="text-[11px] uppercase tracking-wider text-muted/70 mb-0.5">{t('clubs.shareCode')}</div>
              <button
                onClick={() => { void navigator.clipboard?.writeText(mine.joinCode!).then(() => useGameStore.setState({ toast: t('clubs.codeCopied'), toastKind: 'success' })).catch(() => {}); }}
                className="font-mono text-2xl tracking-[0.35em] gold-text font-bold"
                title={t('clubs.shareCodeHint')}
                aria-label={t('common.copyCode')}
              >
                {mine.joinCode}
              </button>
            </div>
          )}
          <ul className="space-y-2">
            {mine.members.map((m, i) => (
              <li key={m.userId} className="flex items-center gap-3 rounded-xl px-4 py-2.5 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                <span className="text-sm font-mono text-muted/70 w-6 text-right shrink-0">{i + 1}</span>
                <span className="pfp shrink-0" style={{ width: 40, height: 40 }}><AvatarFace id={m.avatar} fill className="text-lg leading-none" /></span>
                <span className="font-display font-semibold tracking-wide text-txt flex-1 truncate min-w-0">{m.username}</span>
                {m.role === 'founder' && <span className="tag tag-open shrink-0">{t('clubs.founder')}</span>}
                <span className="text-xs text-muted shrink-0">{t('clubs.lvlWins', { lvl: m.level, wins: m.wins })}</span>
              </li>
            ))}
          </ul>
          <InviteFriendsPanel />
          {error && <p className="text-xs text-red-300">{error}</p>}
        </section>
      ) : null}

      {/* Tournaments / War / Chat as tabs (reusing the landscape tab state) so portrait shows ONE
          at a time instead of stacking all three → no long scroll. */}
      {mine && (
        <>
          <div className="seg grid grid-cols-3" role="tablist" aria-label={mine.name}>
            <button type="button" role="tab" aria-selected={tab === 'turne'} onClick={() => setTab('turne')} className={`seg-tab text-center ${tab === 'turne' ? 'active' : ''}`}>{t('clubs.tournaments')}</button>
            <button type="button" role="tab" aria-selected={tab === 'luftë'} onClick={() => setTab('luftë')} aria-label={t('clubs.warTab')} className={`seg-tab text-center ${tab === 'luftë' ? 'active' : ''}`}>⚔️ {t('clubs.warTab')}</button>
            <button type="button" role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')} className={`seg-tab text-center ${tab === 'chat' ? 'active' : ''}`}>{t('clubs.chatTitle')}</button>
          </div>
          {tab === 'turne' ? <ClubTournaments club={mine} /> : tab === 'luftë' ? <ClubWarPanel club={mine} /> : <ClubChat club={mine} />}
        </>
      )}

      {!mine && status !== 'loading' && (
        <>
          <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.05s' }}>
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('clubs.createClub')}</h2>
            <form className="flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); if (busy || name.trim().length < 3 || tag.trim().length < 2) return; void act(() => clubsApi.create(token()!, name.trim(), tag.trim(), priv)); }}>
              <label className="block flex-1 min-w-[160px]"><span className="field-label">{t('clubs.nameLabel')}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Murlan Masters" className="field" /></label>
              <label className="block"><span className="field-label">{t('clubs.tagLabel')}</span>
                <input value={tag} onChange={(e) => setTag(e.target.value.toUpperCase().slice(0, 5))} maxLength={5} placeholder="MUR" className="field w-24 uppercase font-mono" /></label>
              <button type="submit" disabled={busy || name.trim().length < 3 || tag.trim().length < 2} className="btn btn-gold">{t('clubs.create')}</button>
            </form>
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
                aria-label={t('clubs.joinByCodeTitle')}
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

// ---- Club tournaments panel ------------------------------------------------
// Members-only list of the club's tournaments (register into a registering one).
// The FOUNDER additionally gets a small create form (name / buy-in $ / capacity).
// Money path is identical to global tournaments — escrow + payout happen server-side.
function ClubTournaments({ club }: { club: ClubDetailDTO }) {
  const t = useT();
  const myId = useAuthStore((s) => s.user?.id ?? null);
  const token = () => useAuthStore.getState().accessToken;
  const isFounder = club.members.find((m) => m.userId === myId)?.role === 'founder';

  const [items, setItems] = useState<TournamentDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [buyIn, setBuyIn] = useState('1');
  const [capacity, setCapacity] = useState<2 | 4 | 8>(4);

  async function load() {
    const tk = token();
    if (!tk) return;
    try {
      const r = await tournamentsApi.listByClub(tk, club.id);
      setItems(r.tournaments);
    } catch {
      setError(t('clubs.tournamentsLoadFailed'));
    }
  }
  useEffect(() => { void load(); }, [club.id]);

  const act = async (fn: () => Promise<unknown>) => {
    const tk = token();
    if (!tk || busy) return;
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof ApiError ? e.message : t('clubs.actionFailed')); }
    finally { setBusy(false); }
  };

  const createTournament = () => {
    const buyInCents = Math.max(0, Math.round(parseFloat(buyIn || '0') * 100));
    if (!Number.isFinite(buyInCents)) return;
    void act(async () => {
      await tournamentsApi.create(token()!, name.trim() || 'Turne', buyInCents, capacity, club.id);
      setName('');
    });
  };

  return (
    <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.08s' }}>
      <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('clubs.tournaments')}</h2>
      <p className="text-xs text-muted">{isFounder ? `👑 ${t('clubs.founderOpensTournaments')}` : t('clubs.onlyFounderOpens')}</p>

      {isFounder && (
        <div className="flex flex-wrap gap-3 items-end rounded-xl px-4 py-3 border border-gold/30 bg-gold/[.05]">
          <label className="block flex-1 min-w-[160px]"><span className="field-label">{t('clubs.tournamentName')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Murlan Cup" className="field" /></label>
          <label className="block"><span className="field-label">{t('clubs.buyIn')}</span>
            <input value={buyIn} onChange={(e) => setBuyIn(e.target.value)} inputMode="decimal" className="field w-24" /></label>
          <label className="block"><span className="field-label">{t('clubs.capacity')}</span>
            <select value={capacity} onChange={(e) => setCapacity(Number(e.target.value) as 2 | 4 | 8)} className="field w-20">
              <option value={2}>2</option>
              <option value={4}>4</option>
              <option value={8}>8</option>
            </select></label>
          <button disabled={busy} onClick={createTournament} className="btn btn-gold">{t('clubs.createTournament')}</button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-muted text-center py-6">{t('clubs.noTournaments')}</p>
      ) : (
        <ul className="space-y-2.5">
          {items.map((tn) => {
            const joined = myId ? tn.playerIds.includes(myId) : false;
            return (
              <li key={tn.id} className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                <span className="font-display font-semibold tracking-wide text-txt flex-1 truncate">{tn.name}</span>
                <span className="text-xs text-muted shrink-0">${(tn.buyInCents / 100).toFixed(2)}</span>
                <span className="text-xs text-muted shrink-0">{tn.playerIds.length}/{tn.capacity} 👥</span>
                {tn.status === 'registering' && !joined ? (
                  <button disabled={busy} onClick={() => void act(() => tournamentsApi.register(token()!, tn.id))} className="btn btn-outline shrink-0">{t('clubs.register')}</button>
                ) : (
                  <span className="tag tag-open shrink-0">{tn.status === 'registering' && joined ? '✓' : tn.status}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </section>
  );
}

// ---- Club chat panel -------------------------------------------------------
// Members-only channel. Seeds history (REST) on mount, then live-appends via the
// socket store. Every message carries a Report button; the founder also gets a
// Mute button next to other members. Safety controls (report + founder mute) ship
// WITH the chat — moderation policy review is still required before broad rollout.
function ClubChat({ club }: { club: ClubDetailDTO }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
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
    clubsApi.messages(tk, club.id).then((r) => setClubChat(r.messages)).catch(() => {
      setClubChat([]);
      useGameStore.setState({ toast: tr('clubs.chatLoadFailed'), toastKind: 'error' });
    });
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
    if (!(await confirm({ title: t('clubs.report'), message: t('clubs.reportConfirmM') }))) return;
    await clubsApi.report(tk, messageId, t('clubs.reportReason')).then(() => useGameStore.setState({ toast: t('clubs.reportSuccess'), toastKind: 'success' })).catch(() => useGameStore.setState({ toast: t('clubs.reportFailed'), toastKind: 'error' }));
  };

  const mute = async (userId: string) => {
    const tk = token();
    if (!tk) return;
    if (!(await confirm({ title: t('clubs.mute'), message: t('clubs.muteConfirmM') }))) return;
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
                <span className="text-[10px] text-muted/60 ml-auto shrink-0">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <p className="text-sm text-txt break-words">{m.text}</p>
            </div>
            <div className="flex flex-col items-end gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
              {m.userId !== myId && <button onClick={() => void report(m.id)} className="text-[10px] text-muted hover:text-red-300" title={t('clubs.report')}>⚑</button>}
              {isFounder && m.userId !== myId && <button onClick={() => void mute(m.userId)} className="text-[10px] text-muted hover:text-gold-hi" title={t('clubs.mute')}>🔇</button>}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={280} placeholder={t('clubs.messagePlaceholder')} aria-label={t('clubs.messagePlaceholder')} className="field flex-1" />
        <button type="submit" disabled={busy || !text.trim()} className="btn btn-gold">{t('clubs.send')}</button>
      </form>
      {dialog}
    </section>
  );
}

// ---- Invite-a-friend panel -------------------------------------------------
// Any club member can invite an online accepted friend to the club. The invite is
// delivered over the socket (gameStore.inviteToClub) and gated server-side by
// caller-in-club + areFriends. Shown in both the portrait + landscape layouts.
function InviteFriendsPanel({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const token = () => useAuthStore.getState().accessToken;
  const inviteToClub = useGameStore((s) => s.inviteToClub);
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [invited, setInvited] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const tk = token();
    if (!tk) return;
    friendsApi.list(tk).then((r) => setFriends(r.friends.filter((f) => f.direction === 'friends'))).catch(() => setFriends([]));
  }, []);

  const send = async (userId: string) => {
    const ok = await inviteToClub(userId);
    if (ok) setInvited((m) => ({ ...m, [userId]: true }));
  };

  return (
    <div className={compact ? 'mt-2' : ''}>
      <button onClick={() => setOpen((o) => !o)} className={`btn btn-ghost ${compact ? 'btn-sm w-full' : ''}`} aria-expanded={open}>
        🛡️ {t('clubs.inviteFriend')}
      </button>
      {open && (
        friends.length === 0 ? (
          <p className="text-xs text-muted py-2">{t('clubs.noFriendsToInvite')}</p>
        ) : (
          <ul className="space-y-1.5 mt-2">
            {friends.map((f) => (
              <li key={f.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 border border-white/10 bg-white/[.03]">
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${f.online ? 'bg-emerald-400' : 'bg-white/25'}`} aria-hidden />
                <span className="font-display font-semibold text-txt text-sm flex-1 truncate">{f.user.username}</span>
                <button
                  disabled={!!invited[f.user.id]}
                  onClick={() => void send(f.user.id)}
                  className="btn btn-gold btn-sm shrink-0"
                >
                  {invited[f.user.id] ? t('clubs.invited') : t('friends.invite')}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
