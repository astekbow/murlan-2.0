import { useEffect, useState } from 'react';
import type { MatchType } from '@murlan/shared';
import { useGameStore } from '../store/gameStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore, type LobbyView as LobbyViewName } from '../store/uiStore.ts';
import { dollars } from '../lib/money.ts';
import { sound } from '../lib/sound.ts';
import { Modal } from '../components/ui/Modal.tsx';
import { InstallBanner } from '../components/ui/InstallBanner.tsx';
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

function scrollToRooms() {
  document.getElementById('rooms')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** A vertical rail of nav icons (one on each side of the hero on desktop; wraps
 *  into a row on mobile). `side` only controls the responsive ordering. */
function RailNav({ items, side }: { items: RailItem[]; side: 'left' | 'right' }) {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  return (
    <nav className={`flex md:flex-col flex-row flex-wrap justify-center gap-4 md:gap-5 animate-rise ${side === 'left' ? 'order-2 md:order-1' : 'order-3'}`}>
      {items.map((r) => (
        <button
          key={r.labelKey}
          className="rail-item"
          onClick={() => { sound.play('button'); if (r.to) setView(r.to); }}
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

export function LobbyView() {
  const { lobby, live, createRoom, joinRoom, refreshLobby, findRanked, spectate } = useGameStore();
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);
  const t = useT();

  const [quickOpen, setQuickOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [rankedOpen, setRankedOpen] = useState(false);

  // Refresh the authoritative balance on entry so the join affordability gate
  // ("Pa fonde") reflects any deposit made since login.
  useEffect(() => {
    void useAuthStore.getState().refreshMe();
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">{t('lobby.srTitle')}</h1>
      <InstallBanner />
      {/* Menu: 3 nav icons left · hero · 3 nav icons right (desktop). */}
      <div className="grid gap-5 md:grid-cols-[64px_1fr_64px] items-start">
        <RailNav items={RAIL_LEFT} side="left" />

        {/* Hero mode cards */}
        <div className="grid sm:grid-cols-2 gap-5 order-1 md:order-2">
          <button className="mode casual animate-rise text-inherit" style={{ animationDelay: '.1s' }} onClick={() => { sound.play('button'); setQuickOpen(true); }}>
            <div className="art" />
            <div className="motif">
              <div className="pcard"><span className="pr">A♠</span><span className="pb">♠</span></div>
              <div className="pcard two red"><span className="pr">A♦</span><span className="pb">♦</span></div>
            </div>
            <div className="mname gold-text">{t('lobby.quickName')}</div>
            <div className="mdesc">{t('lobby.quickDesc')}</div>
            <div className="mcta">{t('lobby.quickCta')}</div>
          </button>

          <button className="mode tourn animate-rise text-inherit" style={{ animationDelay: '.15s' }} onClick={() => { sound.play('button'); scrollToRooms(); }}>
            <div className="art" />
            <div className="motif">
              <div className="pcard"><span className="pr">K♠</span><span className="pb">♠</span></div>
              <div className="pcard two red"><span className="pr">Q♥</span><span className="pb">♥</span></div>
            </div>
            <div className="mname gold-text">{t('lobby.tournName')}</div>
            <div className="mdesc">{t('lobby.tournDesc')}</div>
            <div className="mcta">{t('lobby.tournCta')}</div>
          </button>
        </div>

        <RailNav items={RAIL_RIGHT} side="right" />
      </div>

      {/* Ranked matchmaking — skill-matched, feeds the MMR ladder */}
      <button
        onClick={() => { sound.play('button'); setRankedOpen(true); }}
        className="w-full panel p-4 flex items-center justify-between gap-4 hover:border-gold transition-all animate-rise text-left"
        style={{ animationDelay: '.18s' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-3xl shrink-0">⚔️</span>
          <div className="min-w-0">
            <div className="font-display font-bold gold-text tracking-wide">{t('lobby.rankedTitle')}</div>
            <div className="text-xs text-muted truncate">{t('lobby.rankedDesc')}</div>
          </div>
        </div>
        <span className="btn btn-gold shrink-0">{t('lobby.findMatch')}</span>
      </button>

      {/* Open rooms */}
      <section id="rooms" className="panel p-5 animate-rise" style={{ animationDelay: '.2s' }}>
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('lobby.openRooms')}</h2>
          <div className="flex items-center gap-3">
            <button onClick={refreshLobby} className="text-xs text-gold-hi border-b border-dashed border-gold/50">{t('lobby.refresh')}</button>
            <button onClick={() => setCreateOpen(true)} className="btn btn-gold">{t('lobby.createRoom')}</button>
          </div>
        </div>

        {lobby.length === 0 ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">🃏</div>
            <p className="text-sm text-muted">{t('lobby.noRooms')}</p>
            <p className="text-xs text-muted/70 mt-1">{t('lobby.noRoomsHint')}</p>
          </div>
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
                  style={{ animationDelay: `${i * 0.06}s` }}
                >
                  <div className="font-display font-semibold tracking-wide sm:min-w-[110px]">{t(TYPE_LABEL[r.type])}</div>
                  <div className="flex flex-wrap gap-4 text-sm text-muted flex-1">
                    <span>{t('lobby.stake')} <b className="text-txt">{dollars(r.stakeCents)}</b></span>
                    <span><b className="text-txt">{r.seatsFilled}/{r.seatsTotal}</b> {t('lobby.playersSuffix')}</span>
                  </div>
                  {open ? <span className="tag tag-open">{t('lobby.openTag')}</span> : <span className="tag tag-live"><span className="pls" />{t('lobby.playing')}</span>}
                  <button
                    onClick={() => void joinRoom(r.id)}
                    disabled={!joinable}
                    title={open && !full && !canAfford ? t('lobby.cantAfford') : undefined}
                    className={`btn w-full sm:w-auto ${joinable ? 'btn-gold' : 'btn-ghost'}`}
                  >
                    {!open ? t('lobby.playing') : full ? t('lobby.full') : canAfford ? t('lobby.enter') : t('lobby.noFunds')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Live matches — spectate a game in progress */}
      {live.length > 0 && (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.22s' }}>
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('lobby.liveMatches')}</h2>
            <span className="text-xs text-muted">{t('lobby.watchLive')}</span>
          </div>
          <ul className="space-y-2.5">
            {live.map((m, i) => (
              <li
                key={m.roomId}
                className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold transition-all animate-rise"
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <div className="font-display font-semibold tracking-wide sm:min-w-[110px]">{t(TYPE_LABEL[m.type])}</div>
                <div className="flex-1 min-w-0 text-sm text-muted truncate">
                  {m.players.map((p) => p.username).filter(Boolean).join(' · ') || t('lobby.players')}
                </div>
                <span className="tag tag-live shrink-0"><span className="pls" />Live</span>
                <button onClick={() => { sound.play('button'); void spectate(m.roomId); }} className="btn btn-ghost w-full sm:w-auto">👁 {t('lobby.watch')}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {quickOpen && (
        <QuickMatchModal
          onClose={() => setQuickOpen(false)}
          onJoin={joinRoom}
          onCreate={createRoom}
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
      <div className="space-y-4">
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
    <div className="seg w-full grid grid-cols-3">
      {TYPES.map((mt) => (
        <button key={mt} className={`seg-tab text-center ${value === mt ? 'active' : ''}`} onClick={() => onChange(mt)}>
          {t(TYPE_LABEL[mt])}
        </button>
      ))}
    </div>
  );
}

function StakeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <label className="block">
      <span className="field-label">{t('lobby.stakeUsd')}</span>
      <input type="number" min="0" step="0.5" value={value} onChange={(e) => onChange(e.target.value)} className="field" />
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
}
function QuickMatchModal({ onClose, onJoin, onCreate, onRefresh }: QuickProps) {
  const t = useT();
  const [type, setType] = useState<MatchType>('1v1');
  const [stake, setStake] = useState('5');
  const [busy, setBusy] = useState(false);

  // Quick-match = find an open room that matches, else create one and wait.
  // Reuses the existing join/create events — no server matchmaker is invented.
  async function play() {
    if (busy) return;
    setBusy(true);
    const lobby = await onRefresh();
    const cents = toCents(stake);
    const candidate = lobby.find((r) => r.type === type && r.stakeCents === cents && r.status === 'waiting' && r.seatsFilled < r.seatsTotal);
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
    const ok = await useGameStore.getState().startPractice(type);
    if (ok) onClose();
    else setBusy(false);
  }

  return (
    <Modal title={t('lobby.quickName')} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <span className="field-label">{t('lobby.gameType')}</span>
          <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
        </div>
        <StakeField value={stake} onChange={setStake} />
        <p className="text-xs text-muted">{t('lobby.quickBlurb')}</p>
        <button className="btn btn-green btn-lg btn-block" disabled={busy} onClick={() => void play()}>
          {busy ? t('lobby.searching') : t('lobby.quickCta')}
        </button>
        <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => void practice()}>
          {t('lobby.practice')}
        </button>
      </div>
    </Modal>
  );
}

interface CreateProps {
  onClose: () => void;
  onCreate: (type: MatchType, cents: number, team?: 0 | 1) => Promise<string | null>;
}
function CreateRoomModal({ onClose, onCreate }: CreateProps) {
  const t = useT();
  const [type, setType] = useState<MatchType>('1v1');
  const [stake, setStake] = useState('5');
  const [team, setTeam] = useState<0 | 1>(0);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (busy) return;
    setBusy(true);
    await onCreate(type, toCents(stake), type === '2v2' ? team : undefined);
    onClose();
  }

  return (
    <Modal title={t('lobby.createModalTitle')} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <span className="field-label">{t('lobby.gameType')}</span>
          <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
        </div>
        <StakeField value={stake} onChange={setStake} />
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
