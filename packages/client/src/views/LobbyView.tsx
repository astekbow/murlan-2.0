import { useEffect, useState } from 'react';
import type { MatchType } from '@murlan/shared';
import { useGameStore } from '../store/gameStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore, type LobbyView as LobbyViewName } from '../store/uiStore.ts';
import { dollars } from '../lib/money.ts';
import { sound } from '../lib/sound.ts';
import { Modal } from '../components/ui/Modal.tsx';

const TYPE_LABEL: Record<MatchType, string> = {
  '1v1': '1 kundër 1',
  '1v1v1': '1v1v1',
  '2v2': '2 kundër 2',
};
const TYPES: MatchType[] = ['1v1', '1v1v1', '2v2'];

const RAIL: Array<{ icon: string; label: string; badge: string | null; to: LobbyViewName | null }> = [
  { icon: '🏆', label: 'KLASIFIKIMI', badge: null, to: 'leaderboard' },
  { icon: '👥', label: 'MIQTË', badge: null, to: 'friends' },
  { icon: '🎯', label: 'SFIDAT', badge: null, to: 'rewards' },
  { icon: '🛍️', label: 'DYQANI', badge: null, to: 'shop' },
];

function scrollToRooms() {
  document.getElementById('rooms')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function LobbyView() {
  const { lobby, createRoom, joinRoom, refreshLobby } = useGameStore();
  const setView = useUiStore((s) => s.setView);
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);

  const [quickOpen, setQuickOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // Refresh the authoritative balance on entry so the join affordability gate
  // ("Pa fonde") reflects any deposit made since login.
  useEffect(() => {
    void useAuthStore.getState().refreshMe();
  }, []);

  return (
    <div className="space-y-6">
      {/* Menu: side rail + hero */}
      <div className="grid gap-5 md:grid-cols-[76px_1fr] items-start">
        {/* Side rail */}
        <nav className="flex md:flex-col flex-row flex-wrap justify-center gap-4 md:gap-5 animate-rise order-2 md:order-1">
          {RAIL.map((r) => (
            <button
              key={r.label}
              className="rail-item"
              onClick={() => {
                sound.play('button');
                if (r.to) setView(r.to);
              }}
            >
              <span className="rail-ic">
                {r.icon}
                {r.badge && <span className="badge">{r.badge}</span>}
              </span>
              <span className="rail-lbl">{r.label}</span>
            </button>
          ))}
        </nav>

        {/* Hero mode cards */}
        <div className="grid sm:grid-cols-2 gap-5 order-1 md:order-2">
          <button className="mode casual animate-rise text-inherit" style={{ animationDelay: '.1s' }} onClick={() => { sound.play('button'); setQuickOpen(true); }}>
            <div className="art" />
            <div className="motif">
              <div className="pcard"><span className="pr">A♠</span><span className="pb">♠</span></div>
              <div className="pcard two red"><span className="pr">A♦</span><span className="pb">♦</span></div>
            </div>
            <div className="mname gold-text">Lojë e Shpejtë</div>
            <div className="mdesc">1v1 · 1v1v1 · 2v2 — gjej kundërshtar në sekonda</div>
            <div className="mcta">LUAJ TANI</div>
          </button>

          <button className="mode tourn animate-rise text-inherit" style={{ animationDelay: '.15s' }} onClick={() => { sound.play('button'); scrollToRooms(); }}>
            <div className="art" />
            <div className="motif">
              <div className="pcard"><span className="pr">K♠</span><span className="pb">♠</span></div>
              <div className="pcard two red"><span className="pr">Q♥</span><span className="pb">♥</span></div>
            </div>
            <div className="mname gold-text">Turne · Dhomat</div>
            <div className="mdesc">Tavolina me bast · çmime më të mëdha</div>
            <div className="mcta">HYR</div>
          </button>
        </div>
      </div>

      {/* Open rooms */}
      <section id="rooms" className="panel p-5 animate-rise" style={{ animationDelay: '.2s' }}>
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">DHOMAT E HAPURA</h2>
          <div className="flex items-center gap-3">
            <button onClick={refreshLobby} className="text-xs text-gold-hi border-b border-dashed border-gold/50">Rifresko</button>
            <button onClick={() => setCreateOpen(true)} className="btn btn-gold">＋ Krijo dhomë</button>
          </div>
        </div>

        {lobby.length === 0 ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">🃏</div>
            <p className="text-sm text-muted">Nuk ka dhoma të hapura ende.</p>
            <p className="text-xs text-muted/70 mt-1">Provo "Lojë e Shpejtë" ose krijo një dhomë!</p>
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
                  <div className="font-display font-semibold tracking-wide sm:min-w-[110px]">{TYPE_LABEL[r.type]}</div>
                  <div className="flex flex-wrap gap-4 text-sm text-muted flex-1">
                    <span>Basti <b className="text-txt">{dollars(r.stakeCents)}</b></span>
                    <span><b className="text-txt">{r.seatsFilled}/{r.seatsTotal}</b> lojtarë</span>
                  </div>
                  {open ? <span className="tag tag-open">Hapur</span> : <span className="tag tag-live"><span className="pls" />Po luhet</span>}
                  <button
                    onClick={() => void joinRoom(r.id)}
                    disabled={!joinable}
                    title={open && !full && !canAfford ? 'Bilanc i pamjaftueshëm për këtë bast' : undefined}
                    className={`btn w-full sm:w-auto ${joinable ? 'btn-gold' : 'btn-ghost'}`}
                  >
                    {!open ? 'Po luhet' : full ? 'Plot' : canAfford ? 'Hyr' : 'Pa fonde'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
    </div>
  );
}

/** Type picker shared by both modals. */
function TypePicker({ value, onChange }: { value: MatchType; onChange: (t: MatchType) => void }) {
  return (
    <div className="seg w-full grid grid-cols-3">
      {TYPES.map((t) => (
        <button key={t} className={`seg-tab text-center ${value === t ? 'active' : ''}`} onClick={() => onChange(t)}>
          {TYPE_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

function StakeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="field-label">Basti (USD)</span>
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

  return (
    <Modal title="Lojë e Shpejtë" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <span className="field-label">Lloji i lojës</span>
          <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
        </div>
        <StakeField value={stake} onChange={setStake} />
        <p className="text-xs text-muted">Do të të çojmë te një tavolinë e hapur që përputhet, ose do hapim një të re dhe presim kundërshtar.</p>
        <button className="btn btn-green btn-lg btn-block" disabled={busy} onClick={() => void play()}>
          {busy ? 'Po kërkojmë…' : 'LUAJ TANI'}
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
    <Modal title="Krijo dhomë" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <span className="field-label">Lloji i lojës</span>
          <div className="mt-1"><TypePicker value={type} onChange={setType} /></div>
        </div>
        <StakeField value={stake} onChange={setStake} />
        {type === '2v2' && (
          <label className="block">
            <span className="field-label">Ekipi</span>
            <select value={team} onChange={(e) => setTeam(Number(e.target.value) as 0 | 1)} className="field">
              <option value={0}>Ekipi 1</option>
              <option value={1}>Ekipi 2</option>
            </select>
          </label>
        )}
        <button className="btn btn-gold btn-lg btn-block" disabled={busy} onClick={() => void create()}>
          {busy ? 'Po krijohet…' : 'KRIJO DHOMË'}
        </button>
      </div>
    </Modal>
  );
}
