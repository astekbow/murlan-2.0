import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MatchType, LobbyRoomInfo } from '@murlan/shared';
import { useGameStore } from '../store/gameStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore, type LobbyView as LobbyViewName } from '../store/uiStore.ts';
import { dollars } from '../lib/money.ts';
import { lobbyApi, friendsApi, type LobbyLiveDTO, type FriendEntry } from '../lib/api.ts';
import { AvatarFace } from '../components/ui/AvatarFace.tsx';
import { sound } from '../lib/sound.ts';
import { haptics } from '../lib/haptics.ts';
import { Modal } from '../components/ui/Modal.tsx';
import { PageHeader } from '../components/ui/PageHeader.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { useT } from '../lib/i18n.ts';

// Maps match type → catalog key, resolved with t() at each use site.
const TYPE_LABEL: Record<MatchType, string> = {
  '1v1': 'lobby.type1v1',
  '1v1v1': 'lobby.type1v1v1',
  '2v2': 'lobby.type2v2',
};
const TYPES: MatchType[] = ['1v1', '1v1v1', '2v2'];

interface RailItem { icon: string; labelKey: string; badge: string | null; to: LobbyViewName | null }
// Split into two rails — 3 on the left, 3 on the right of the hero (desktop).
// Support lives in the ⚙ settings menu now (not the rail).
const RAIL_LEFT: RailItem[] = [
  { icon: '🏆', labelKey: 'nav.leaderboard', badge: null, to: 'leaderboard' },
  { icon: '👥', labelKey: 'nav.friends', badge: null, to: 'friends' },
  { icon: '🛡️', labelKey: 'nav.clubs', badge: null, to: 'clubs' },
];
const RAIL_RIGHT: RailItem[] = [
  { icon: '🎯', labelKey: 'nav.challenges', badge: null, to: 'rewards' },
  { icon: '🛍️', labelKey: 'nav.shop', badge: null, to: 'shop' },
  { icon: '♛', labelKey: 'nav.vip', badge: null, to: 'vip' },
];

/** A vertical rail of nav icons (one on each side of the hero on desktop; wraps
 *  into a row on mobile). `side` only controls the responsive ordering. */
function RailNav({ items, side }: { items: RailItem[]; side: 'left' | 'right' }) {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const view = useUiStore((s) => s.view);
  return (
    <nav aria-label={t(side === 'left' ? 'nav.railPrimary' : 'nav.railSecondary')} className={`flex md:flex-col flex-row flex-wrap justify-center gap-4 md:gap-5 animate-rise ${side === 'left' ? 'order-2 md:order-1' : 'order-3'}`}>
      {items.map((r) => (
        <button
          key={r.labelKey}
          className="rail-item"
          aria-current={r.to && r.to === view ? 'page' : undefined}
          onClick={() => { sound.play('button'); haptics.tap(); if (r.to) setView(r.to); }}
        >
          <span className="rail-ic">
            {r.icon}
            {r.badge && <span className="badge">{r.badge}</span>}
          </span>
          <span className="rail-lbl">{t(r.labelKey)}</span>
        </button>
      ))}
    </nav>
  );
}

/** Compact lobby-liveliness strip: a live "X online" chip + a subtle ticker of recent
 *  real-money winners ("Ardit fitoi $20"). Display-only; data is polled read-only. */
function LobbyLiveStrip({ data }: { data: LobbyLiveDTO | null }) {
  const t = useT();
  const winners = data?.recentWinners ?? [];
  if (winners.length === 0) return null; // nothing to show (online-count chip removed by owner)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm animate-rise" aria-live="polite">
      {winners.length > 0 && (
        <span className="min-w-0 flex-1 flex items-baseline gap-2 overflow-hidden">
          <span className="shrink-0 font-serif text-[10px] tracking-[0.25em] text-muted uppercase">{t('lobby.recentWinners')}</span>
          <span className="min-w-0 truncate text-muted">
            {winners.map((w, i) => (
              <span key={`${w.at}-${i}`} className={i === 0 ? 'text-gold-hi' : undefined}>
                {i > 0 && <span className="text-muted/50"> · </span>}
                {t('lobby.winnerLine', { name: w.username, amount: dollars(w.amountCents) })}
              </span>
            ))}
          </span>
        </span>
      )}
    </div>
  );
}

/** Compact "friends online now" strip on the hub — tap a friend to challenge them to a free 1v1 duel. */
function FriendsOnlineStrip() {
  const t = useT();
  const [count, setCount] = useState(0);
  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    let alive = true;
    const pull = () => { void friendsApi.list(token).then((r) => { if (alive) setCount(r.friends.filter((f) => f.direction === 'friends' && f.online).length); }).catch(() => {}); };
    pull();
    const id = window.setInterval(pull, 20_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);
  if (count === 0) return null;
  // Just a compact COUNT (owner request) — no per-friend avatar chips.
  return (
    <div className="flex items-center justify-center animate-rise">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[.04] px-3 py-1">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" aria-hidden />
        <span className="text-xs font-display font-semibold text-txt">{t('lobby.friendsOnlineCount', { n: count })}</span>
      </span>
    </div>
  );
}

export function LobbyView() {
  // perf-4: select each field (state + stable actions) instead of subscribing to the WHOLE game
  // store — so an unrelated store update doesn't re-render the entire lobby.
  const lobby = useGameStore((s) => s.lobby);
  const live = useGameStore((s) => s.live);
  const createRoom = useGameStore((s) => s.createRoom);
  const joinRoom = useGameStore((s) => s.joinRoom);
  const joinByCode = useGameStore((s) => s.joinByCode);
  const refreshLobby = useGameStore((s) => s.refreshLobby);
  const findRanked = useGameStore((s) => s.findRanked);
  const spectate = useGameStore((s) => s.spectate);
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);
  const setView = useUiStore((s) => s.setView);
  const t = useT();
  const landscape = useLandscapePage();

  const [quickOpen, setQuickOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [rankedOpen, setRankedOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [showRooms, setShowRooms] = useState(false); // Open-rooms opens its own page
  const [joinTeamFor, setJoinTeamFor] = useState<LobbyRoomInfo | null>(null); // 2v2: pick a team before joining

  const onJoinByCode = async () => {
    const c = codeInput.trim();
    if (c.length < 4) return;
    const ok = await joinByCode(c);
    if (ok) setCodeInput('');
  };

  // 2v2 → let the player choose their team first; other modes join straight in.
  const handleJoin = (r: LobbyRoomInfo) => {
    if (r.type === '2v2') setJoinTeamFor(r);
    else void joinRoom(r.id);
  };

  // A 0-stake room is a FREE game — show "Falas" instead of "$0.00" wherever a stake
  // is displayed. (Such a room is always affordable; the join gate never blocks it.)
  const stakeLabel = (cents: number) => (cents === 0 ? t('lobby.free') : dollars(cents));

  // Refresh the authoritative balance on entry so the join affordability gate
  // ("Pa fonde") reflects any deposit made since login.
  useEffect(() => {
    void useAuthStore.getState().refreshMe();
  }, []);

  // Lobby liveliness: poll the read-only online-count + recent-winners snapshot every
  // 15s (cheap, in-memory on the server). Best-effort — a failure just keeps the last
  // value (or none); it never blocks play.
  const [live2, setLive2] = useState<LobbyLiveDTO | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => { void lobbyApi.live().then((d) => { if (alive) setLive2(d); }).catch(() => {}); };
    pull();
    const id = window.setInterval(pull, 15_000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  // ---- Landscape "console" (phone held flat): a fixed-height frame that fits with
  // NO page scroll. Because the full-screen portal COVERS the global <TopBar>, the
  // lobby's top strip must replicate its essentials (profile · balance · 🔔 · ⚙) —
  // see LobbyTopStrip, which reuses the very stores/panels TopBar uses.
  // Portaled to <body> so it escapes the ViewTransition transform (which would
  // otherwise trap position:fixed inside <main>, under the TopBar).
  // ONLY the open-rooms sub-page becomes a landscape console. The HOME HUB keeps its
  // original layout (the owner wants the home view unchanged) — it falls through below.
  if (landscape && showRooms) {
    return createPortal(
        /* ---- Landscape OPEN-ROOMS ---- */
        <div className="pg-ls">
          <div className="pg-ls-top">
            <button onClick={() => { sound.play('button'); haptics.tap(); setShowRooms(false); }} className="btn btn-ghost btn-sm">{t('common.backToLobby')}</button>
            <h1 className="pg-ls-title gold-text font-display font-bold tracking-wide truncate">{t('lobby.openRooms')}</h1>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm font-display font-semibold text-gold-hi">{dollars(balanceCents)}</span>
              <button onClick={() => setCreateOpen(true)} className="btn btn-gold btn-sm" aria-label={t('lobby.createRoom')}>＋</button>
            </div>
          </div>
          <div className="pg-ls-body">
            <div className="pg-ls-right pg-ls-scroll space-y-2 pr-1">
              {/* Join a PRIVATE room by its numeric share code. */}
              <div className="flex items-center gap-2">
                <input
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void onJoinByCode(); }}
                  placeholder={t('lobby.joinCodePlaceholder')}
                  aria-label={t('lobby.joinByCode')}
                  maxLength={6}
                  inputMode="numeric"
                  className="field flex-1 tracking-[0.3em] font-mono text-center"
                />
                <button onClick={() => void onJoinByCode()} disabled={codeInput.trim().length < 4} className="btn btn-ghost btn-sm shrink-0">{t('lobby.joinByCode')}</button>
                <button onClick={refreshLobby} className="btn btn-ghost btn-icon btn-sm shrink-0" title={t('lobby.refresh')} aria-label={t('lobby.refresh')}>↻</button>
              </div>
              {lobby.length === 0 ? (
                <EmptyState
                  message={t('lobby.noRooms')}
                  hint={t('lobby.noRoomsHint')}
                  action={<button onClick={() => { sound.play('button'); haptics.tap(); setCreateOpen(true); }} className="btn btn-gold btn-sm">{t('lobby.createRoom')}</button>}
                />
              ) : (
                <ul className="space-y-1.5">
                  {lobby.map((r) => {
                    const open = r.status === 'waiting';
                    const full = r.seatsFilled >= r.seatsTotal;
                    const canAfford = balanceCents >= r.stakeCents;
                    const joinable = open && !full && canAfford;
                    return (
                      <li key={r.id} className="flex items-center gap-2 rounded-lg px-3 py-2 border border-white/10 bg-white/[.03]">
                        <span className="font-display font-semibold tracking-wide text-sm min-w-[84px]">{t(TYPE_LABEL[r.type])}</span>
                        <span className="text-xs text-muted">{stakeLabel(r.stakeCents)}</span>
                        <span className="text-xs text-muted">{r.seatsFilled}/{r.seatsTotal} 👥</span>
                        {open ? <span className="tag tag-open">{t('lobby.openTag')}</span> : <span className="tag tag-live"><span className="pls" />{t('lobby.playing')}</span>}
                        {open && !full && !canAfford ? (
                          <button type="button" onClick={() => setView('wallet')} className="btn btn-sm btn-outline ml-auto shrink-0">{t('lobby.deposit')}</button>
                        ) : (
                          <button
                            onClick={() => handleJoin(r)}
                            disabled={!joinable}
                            className={`btn btn-sm ml-auto shrink-0 ${joinable ? 'btn-gold' : 'btn-ghost'}`}
                          >
                            {!open ? t('lobby.playing') : full ? t('lobby.full') : t('lobby.enter')}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          {createOpen && <CreateRoomModal onClose={() => setCreateOpen(false)} onCreate={createRoom} />}
          {joinTeamFor && <JoinTeamModal room={joinTeamFor} onClose={() => setJoinTeamFor(null)} onJoin={joinRoom} />}
        </div>,
      document.getElementById('root') ?? document.body,
    );
  }

  return (
    <div className="lobby-root space-y-4">
      {/* One <h1> per page: the open-rooms page gets its <h1> from <PageHeader> below,
          so the sr-only heading is only rendered on the home page (which has none). */}
      {!showRooms && <h1 className="sr-only">{t('lobby.srTitle')}</h1>}
      {showRooms ? (
        /* ---- Open rooms — its own page ---- */
        <div className="space-y-4 animate-rise">
          <div className="flex items-center justify-between gap-3">
            <button onClick={() => { sound.play('button'); haptics.tap(); setShowRooms(false); }} className="btn btn-ghost btn-sm">{t('common.backToLobby')}</button>
            <div className="flex items-center gap-2">
              <button onClick={refreshLobby} className="btn btn-ghost btn-icon btn-sm" title={t('lobby.refresh')} aria-label={t('lobby.refresh')}>↻</button>
              <button onClick={() => setCreateOpen(true)} className="btn btn-gold btn-sm">{t('lobby.createRoom')}</button>
            </div>
          </div>

          <PageHeader eyebrow={t('lobby.roomsEyebrow')} title={t('lobby.openRooms')} trailing={<span className="text-4xl opacity-80" aria-hidden>🃏</span>} />

          <section className="panel p-5">
            {/* Join a PRIVATE room by its numeric share code. */}
            <div className="flex items-center gap-2 mb-3">
              <input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') void onJoinByCode(); }}
                placeholder={t('lobby.joinCodePlaceholder')}
                aria-label={t('lobby.joinByCode')}
                maxLength={6}
                inputMode="numeric"
                className="field flex-1 tracking-[0.3em] font-mono text-center"
              />
              <button onClick={() => void onJoinByCode()} disabled={codeInput.trim().length < 4} className="btn btn-ghost shrink-0">{t('lobby.joinByCode')}</button>
            </div>

            {lobby.length === 0 ? (
              <EmptyState
                message={t('lobby.noRooms')}
                hint={t('lobby.noRoomsHint')}
                action={<button onClick={() => { sound.play('button'); haptics.tap(); setCreateOpen(true); }} className="btn btn-gold btn-sm">{t('lobby.createRoom')}</button>}
              />
            ) : (
              <ul className="space-y-2.5">
                {lobby.map((r, i) => {
                  const open = r.status === 'waiting';
                  const full = r.seatsFilled >= r.seatsTotal;
                  const canAfford = balanceCents >= r.stakeCents;
                  const joinable = open && !full && canAfford;
                  return (
                    <li
                      key={r.id}
                      className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold hover:translate-x-0.5 transition-all animate-rise"
                      style={{ animationDelay: `${Math.min(i, 6) * 0.05}s` }}
                    >
                      <div className="font-display font-semibold tracking-wide sm:min-w-[110px]">{t(TYPE_LABEL[r.type])}</div>
                      <div className="flex flex-wrap gap-4 text-sm text-muted flex-1">
                        <span>{t('lobby.stake')} <b className="text-txt">{stakeLabel(r.stakeCents)}</b></span>
                        <span><b className="text-txt">{r.seatsFilled}/{r.seatsTotal}</b> {t('lobby.playersSuffix')}</span>
                      </div>
                      {open ? <span className="tag tag-open">{t('lobby.openTag')}</span> : <span className="tag tag-live"><span className="pls" />{t('lobby.playing')}</span>}
                      {/* No funds → a live path to deposit, not a dead greyed button. */}
                      {open && !full && !canAfford ? (
                        <button type="button" onClick={() => setView('wallet')} className="btn btn-outline w-full sm:w-auto">{t('lobby.deposit')}</button>
                      ) : (
                        <button
                          onClick={() => handleJoin(r)}
                          disabled={!joinable}
                          className={`btn w-full sm:w-auto ${joinable ? 'btn-gold' : 'btn-ghost'}`}
                        >
                          {!open ? t('lobby.playing') : full ? t('lobby.full') : t('lobby.enter')}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {live.length > 0 && (
            <section className="panel p-5">
              <div className="flex items-center justify-between mb-3 gap-2">
                <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('lobby.liveMatches')}</h2>
                <span className="text-xs text-muted">{t('lobby.watchLive')}</span>
              </div>
              <ul className="space-y-2.5">
                {live.map((m, i) => (
                  <li
                    key={m.roomId}
                    className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold transition-all"
                    style={{ animationDelay: `${Math.min(i, 6) * 0.05}s` }}
                  >
                    <div className="font-display font-semibold tracking-wide sm:min-w-[110px]">{t(TYPE_LABEL[m.type])}</div>
                    <div className="flex-1 min-w-0 text-sm text-muted truncate">
                      {m.players.map((p) => p.username).filter(Boolean).join(' · ') || t('lobby.players')}
                    </div>
                    <span className="tag tag-live shrink-0"><span className="pls" />{t('common.live')}</span>
                    <button onClick={() => { sound.play('button'); void spectate(m.roomId); }} className="btn btn-ghost w-full sm:w-auto">👁 {t('lobby.watch')}</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        /* ---- Home — four equal cards ---- */
        <div className="lobby-home space-y-3">
          {/* Friends online now → one-tap free duel. */}
          <FriendsOnlineStrip />
          {/* Recent-winners ticker (display-only). */}
          <LobbyLiveStrip data={live2} />
          <div className="lobby-hub grid gap-4 md:grid-cols-[64px_1fr_64px] items-start">
          <RailNav items={RAIL_LEFT} side="left" />

          <div className="grid grid-cols-2 gap-3 sm:gap-4 order-1 md:order-2">
            <button className="mode casual mode-hero animate-rise text-inherit" style={{ animationDelay: '.05s' }} onClick={() => { sound.play('button'); haptics.tap(); setQuickOpen(true); }}>
              <span className="mode-badge" aria-hidden>⚡ {t('lobby.instant')}</span>
              <div className="art" />
              <span className="micon" aria-hidden>🎴</span>
              <div className="mname gold-text">{t('lobby.quickName')}</div>
              <div className="mdesc">{t('lobby.quickDesc')}</div>
              <div className="mcta">{t('lobby.quickCta')}</div>
            </button>

            <button className="mode tourn animate-rise text-inherit" style={{ animationDelay: '.1s' }} onClick={() => { sound.play('button'); haptics.tap(); setView('tournaments'); }}>
              <div className="art" />
              <span className="micon" aria-hidden>🏆</span>
              <div className="mname gold-text">{t('lobby.tournName')}</div>
              <div className="mdesc">{t('lobby.tournDesc')}</div>
              <div className="mcta">{t('lobby.tournCta')}</div>
            </button>

            <button className="mode ranked animate-rise text-inherit" style={{ animationDelay: '.15s' }} onClick={() => { sound.play('button'); haptics.tap(); setRankedOpen(true); }}>
              <div className="art" />
              <span className="micon" aria-hidden>⚔️</span>
              <div className="mname gold-text">{t('lobby.rankedTitle')}</div>
              <div className="mdesc">{t('lobby.rankedDesc')}</div>
              <div className="mcta">{t('lobby.findMatch')}</div>
            </button>

            <button className="mode rooms animate-rise text-inherit" style={{ animationDelay: '.2s' }} onClick={() => { sound.play('button'); haptics.tap(); setShowRooms(true); }}>
              <div className="art" />
              <span className="micon" aria-hidden>🃏</span>
              <div className="mname gold-text">{t('lobby.openRooms')}</div>
              <div className="mdesc">{t('lobby.roomsCardDesc')}</div>
              <div className="mcta">{t('lobby.roomsCardCta')}</div>
            </button>
          </div>

          <RailNav items={RAIL_RIGHT} side="right" />
          </div>
        </div>
      )}

      {quickOpen && (
        <QuickMatchModal
          onClose={() => setQuickOpen(false)}
          onJoin={joinRoom}
          onCreate={createRoom}
          onPickTeam={(r) => setJoinTeamFor(r)}
          onRefresh={async () => {
            // Kick a lobby refresh and await the store landing the fresh list,
            // so quick-match matches against current data (not a stale prop).
            refreshLobby();
            await new Promise((r) => setTimeout(r, 250));
            return useGameStore.getState().lobby;
          }}
        />
      )}
      {createOpen && <CreateRoomModal onClose={() => setCreateOpen(false)} onCreate={createRoom} />}
      {joinTeamFor && <JoinTeamModal room={joinTeamFor} onClose={() => setJoinTeamFor(null)} onJoin={joinRoom} />}
      {rankedOpen && <RankedModal onClose={() => setRankedOpen(false)} onFind={findRanked} />}
    </div>
  );
}

interface RankedProps {
  onClose: () => void;
  onFind: (type: MatchType) => Promise<boolean>;
}
function RankedModal({ onClose, onFind }: RankedProps) {
  const t = useT();
  const [type, setType] = useState<MatchType>('1v1');
  const [busy, setBusy] = useState(false);

  async function find() {
    if (busy) return;
    setBusy(true);
    const ok = await onFind(type);
    if (ok) onClose(); // the searching overlay takes over until matched
    else setBusy(false);
  }

  return (
    <Modal title={t('lobby.rankedModalTitle')} onClose={onClose}>
      {/* Already short (type picker + blurb + button); space-y-3 keeps it well clear of
          a short landscape screen's height — no internal scroll. */}
      <div className="space-y-3">
        <div>
          <span className="field-label">{t('lobby.gameType')}</span>
          <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
        </div>
        <p className="text-xs text-muted">{t('lobby.rankedBlurb')}</p>
        <button className="btn btn-gold btn-lg btn-block" disabled={busy} onClick={() => void find()}>
          {busy ? t('lobby.entering') : t('lobby.findMatch')}
        </button>
      </div>
    </Modal>
  );
}

/** Type picker shared by both modals. */
function TypePicker({ value, onChange }: { value: MatchType; onChange: (t: MatchType) => void }) {
  const t = useT();
  return (
    <div className="seg w-full grid grid-cols-3" role="group">
      {TYPES.map((mt) => (
        <button key={mt} type="button" aria-pressed={value === mt} className={`seg-tab text-center ${value === mt ? 'active' : ''}`} onClick={() => onChange(mt)}>
          {t(TYPE_LABEL[mt])}
        </button>
      ))}
    </div>
  );
}

function StakeField({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter?: () => void }) {
  const t = useT();
  return (
    <label className="block">
      <span className="field-label">{t('lobby.stakeUsd')}</span>
      <input
        type="number"
        min="0"
        step="0.5"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } } : undefined}
        className="field"
      />
    </label>
  );
}

function toCents(stake: string): number {
  const c = Math.round(parseFloat(stake || '0') * 100);
  return Number.isFinite(c) ? Math.max(0, c) : 0;
}

interface QuickProps {
  onClose: () => void;
  onJoin: (id: string) => Promise<boolean>;
  onCreate: (type: MatchType, cents: number, team?: 0 | 1) => Promise<string | null>;
  onRefresh: () => Promise<ReturnType<typeof useGameStore.getState>['lobby']>;
  onPickTeam: (room: LobbyRoomInfo) => void; // 2v2: choose a team before joining (same modal as Open Rooms)
}
function QuickMatchModal({ onClose, onJoin, onCreate, onRefresh, onPickTeam }: QuickProps) {
  const t = useT();
  const [tab, setTab] = useState<'play' | 'practice'>('play');
  const [type, setType] = useState<MatchType>('1v1');
  const [stake, setStake] = useState('0');
  const [tier, setTier] = useState<'easy' | 'medium' | 'hard'>('medium');
  const [busy, setBusy] = useState(false);

  // Quick-match = find an open room that matches, else create one and wait.
  // Reuses the existing join/create events — no server matchmaker is invented.
  async function play() {
    if (busy) return;
    setBusy(true);
    const lobby = await onRefresh();
    const cents = toCents(stake);
    const candidate = lobby.find((r) => r.type === type && r.stakeCents === cents && r.status === 'waiting' && r.seatsFilled < r.seatsTotal);
    // 2v2: found a table → let the player pick their team first (same picker as Open Rooms),
    // instead of auto-seating them. Creating a fresh table (no candidate) falls through to the
    // in-room picker. Non-2v2 joins straight in.
    if (candidate && candidate.type === '2v2') { onClose(); onPickTeam(candidate); return; }
    let ok = false;
    if (candidate) ok = await onJoin(candidate.id);
    // Fall through to creating our own table only if we didn't join one. Close the
    // modal only on success — on failure the store's toast explains why and the
    // modal stays open so the user can retry (not silently dismissed).
    if (!ok) ok = (await onCreate(type, cents)) !== null;
    if (ok) onClose();
    else setBusy(false);
  }

  // Practice vs AI bots: a private zero-stake table that starts instantly. No
  // matchmaking, no money — great for learning the rules or warming up.
  async function practice() {
    if (busy) return;
    setBusy(true);
    const ok = await useGameStore.getState().startPractice(type, tier);
    if (ok) onClose();
    else setBusy(false);
  }

  return (
    <Modal title={t('lobby.quickName')} onClose={onClose}>
      <div className="space-y-4">
        {/* Two tabs keep each panel short enough to fit a flat phone with NO scroll:
            "Luaj" (real/free vs people) and "Praktikë" (vs bots). */}
        <div className="seg w-full grid grid-cols-2">
          <button type="button" className={`seg-tab text-center ${tab === 'play' ? 'active' : ''}`} aria-pressed={tab === 'play'} onClick={() => setTab('play')}>{t('lobby.tabPlay')}</button>
          <button type="button" className={`seg-tab text-center ${tab === 'practice' ? 'active' : ''}`} aria-pressed={tab === 'practice'} onClick={() => setTab('practice')}>{t('lobby.tabPractice')}</button>
        </div>

        {tab === 'play' ? (
          <>
            <div>
              <span className="field-label">{t('lobby.gameType')}</span>
              <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
            </div>
            <div>
              <StakeField value={stake} onChange={setStake} onEnter={() => void play()} />
              <p className="text-xs text-muted mt-1">{t('lobby.freeHint')}</p>
            </div>
            <button className="btn btn-green btn-lg btn-block" disabled={busy} onClick={() => void play()}>
              {busy ? t('lobby.searching') : t('lobby.quickCta')}
            </button>
          </>
        ) : (
          <>
            <div>
              <span className="field-label">{t('lobby.gameType')}</span>
              <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
            </div>
            {/* Bot difficulty applies to the practice game below. */}
            <div>
              <span className="field-label">{t('lobby.botDifficulty')}</span>
              <div className="mt-1 grid grid-cols-3 gap-1.5">
                {(['easy', 'medium', 'hard'] as const).map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    aria-pressed={tier === lv}
                    onClick={() => setTier(lv)}
                    className={`btn btn-sm ${tier === lv ? 'btn-gold' : 'btn-ghost'}`}
                  >
                    {t(lv === 'easy' ? 'lobby.botEasy' : lv === 'medium' ? 'lobby.botMedium' : 'lobby.botHard')}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn btn-gold btn-lg btn-block" disabled={busy} onClick={() => void practice()}>
              {t('lobby.practice')}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

// 2v2 only: pick which team to join (full teams disabled). The server still validates the choice
// (rejects a full team), so this is a UX convenience over the auto-assignment, not a trust boundary.
function JoinTeamModal({ room, onClose, onJoin }: { room: LobbyRoomInfo; onClose: () => void; onJoin: (id: string, team?: 0 | 1) => Promise<boolean> }) {
  const t = useT();
  const [busy, setBusy] = useState<0 | 1 | null>(null);
  const filled = room.teams ?? [0, 0];
  async function pick(team: 0 | 1) {
    if (busy !== null) return;
    setBusy(team);
    const ok = await onJoin(room.id, team);
    if (ok) onClose();
    else setBusy(null); // failure → store toast explains; modal stays open to retry the other team
  }
  return (
    <Modal title={t('lobby.chooseTeam')} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        {([0, 1] as const).map((team) => {
          const full = filled[team] >= 2;
          return (
            <button
              key={team}
              type="button"
              disabled={full || busy !== null}
              onClick={() => void pick(team)}
              className={`btn btn-lg flex flex-col items-center gap-1 py-4 ${full ? 'btn-ghost' : 'btn-gold'}`}
            >
              <span>{t(team === 0 ? 'lobby.team1' : 'lobby.team2')}</span>
              <span className="text-xs opacity-80">{full ? t('lobby.full') : `${filled[team]}/2`}</span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

interface CreateProps {
  onClose: () => void;
  onCreate: (type: MatchType, cents: number, team?: 0 | 1, priv?: boolean) => Promise<string | null>;
}
function CreateRoomModal({ onClose, onCreate }: CreateProps) {
  const t = useT();
  const [type, setType] = useState<MatchType>('1v1');
  const [stake, setStake] = useState('0');
  const [team, setTeam] = useState<0 | 1>(0);
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (busy) return;
    setBusy(true);
    // Close only on success; on failure the store's toast explains why and the
    // modal stays open with the inputs intact so the user can retry.
    const roomId = await onCreate(type, toCents(stake), type === '2v2' ? team : undefined, priv);
    if (roomId) onClose();
    else setBusy(false);
  }

  return (
    <Modal title={t('lobby.createModalTitle')} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <span className="field-label">{t('lobby.gameType')}</span>
          <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
        </div>
        <div>
          <StakeField value={stake} onChange={setStake} onEnter={() => void create()} />
          <p className="text-xs text-muted mt-1">{t('lobby.freeHintStake')}</p>
        </div>
        <label className="flex items-center gap-2.5 cursor-pointer select-none">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="w-4 h-4 accent-gold" />
          <span className="text-sm text-txt">{t('lobby.privateRoom')}</span>
          <span className="text-[11px] text-muted/70">{t('lobby.privateHint')}</span>
        </label>
        {type === '2v2' && (
          <label className="block">
            <span className="field-label">{t('lobby.team')}</span>
            <select value={team} onChange={(e) => setTeam(Number(e.target.value) as 0 | 1)} className="field">
              <option value={0}>{t('lobby.team1')}</option>
              <option value={1}>{t('lobby.team2')}</option>
            </select>
          </label>
        )}
        <button className="btn btn-gold btn-lg btn-block" disabled={busy} onClick={() => void create()}>
          {busy ? t('lobby.creating') : t('lobby.createCta')}
        </button>
      </div>
    </Modal>
  );
}
