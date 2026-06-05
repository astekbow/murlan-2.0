import { useEffect, useState } from 'react';
import { profileApi, rankedApi, ApiError } from '../lib/api.ts';
import type { LeaderboardRow, RankedLeaderboardRow, SeasonDTO } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { avatarEmoji } from '../lib/avatars.ts';
import { TierBadge } from '../components/ui/TierBadge.tsx';

function rankClass(rank: number): string {
  if (rank === 1) return 'text-gold-hi';
  if (rank === 2) return 'text-txt';
  if (rank === 3) return 'text-gold';
  return 'text-muted';
}

function rankLabel(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

type Tab = 'global' | 'ranked';

export function LeaderboardView() {
  const setView = useUiStore((s) => s.setView);
  const myId = useAuthStore((s) => s.user?.id) ?? null;

  const [tab, setTab] = useState<Tab>('global');
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [ranked, setRanked] = useState<RankedLeaderboardRow[]>([]);
  const [season, setSeason] = useState<SeasonDTO | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setError(null);
    const work =
      tab === 'global'
        ? profileApi.leaderboard().then(({ rows }) => { if (alive) setRows(rows); })
        : Promise.all([rankedApi.season(), rankedApi.leaderboard()]).then(([s, l]) => {
            if (!alive) return;
            setSeason(s.season);
            setRanked(l.rows);
          });
    work
      .then(() => { if (alive) setStatus('ready'); })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : 'Klasifikimi nuk u ngarkua.');
        setStatus('error');
      });
    return () => { alive = false; };
  }, [tab]);

  return (
    <div className="space-y-5">
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        ← Kthehu te lobi
      </button>

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">RENDITJA</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">KLASIFIKIMI</h1>
        </div>
        <span className="text-4xl opacity-80">🏆</span>
      </section>

      {/* Tabs: global XP vs ranked season ladder */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab('global')}
          className={`btn flex-1 ${tab === 'global' ? 'btn-gold' : 'btn-ghost'}`}
        >
          🏆 Globale (XP)
        </button>
        <button
          onClick={() => setTab('ranked')}
          className={`btn flex-1 ${tab === 'ranked' ? 'btn-gold' : 'btn-ghost'}`}
        >
          👑 Ranked
        </button>
      </div>

      <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">
            {tab === 'global' ? 'TABELA GLOBALE' : 'LADDER-I RANKED'}
          </h2>
          <span className="text-xs text-muted">
            {tab === 'global'
              ? 'Renditja globale sipas XP-së'
              : season
                ? `Sezoni ${season.number} · ${season.name}`
                : 'Sezoni i ranked'}
          </span>
        </div>

        {status === 'loading' ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60 animate-pulse">{tab === 'ranked' ? '👑' : '🏆'}</div>
            <p className="text-sm text-muted">Po ngarkohet klasifikimi…</p>
          </div>
        ) : status === 'error' ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">⚠️</div>
            <p className="text-sm text-red-300">{error}</p>
          </div>
        ) : tab === 'ranked' && !season ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">👑</div>
            <p className="text-sm text-muted">Ende nuk ka sezon ranked aktiv.</p>
            <p className="text-xs text-muted/70 mt-1">Sezoni i ardhshëm fillon së shpejti — bëhu gati të ngjitesh!</p>
          </div>
        ) : tab === 'global' ? (
          <GlobalBoard rows={rows} myId={myId} />
        ) : (
          <RankedBoard rows={ranked} myId={myId} />
        )}
      </section>
    </div>
  );
}

function GlobalBoard({ rows, myId }: { rows: LeaderboardRow[]; myId: string | null }) {
  if (rows.length === 0) {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-2 opacity-60">🃏</div>
        <p className="text-sm text-muted">Ende nuk ka lojtarë në klasifikim.</p>
        <p className="text-xs text-muted/70 mt-1">Luaj ndeshje për të fituar XP dhe për t'u renditur!</p>
      </div>
    );
  }
  return (
    <>
      <div className="hidden sm:flex items-center gap-3 px-4 pb-2 text-[11px] uppercase tracking-wider text-muted/70">
        <span className="w-9 text-center">#</span>
        <span className="w-[54px]" />
        <span className="flex-1">Lojtari</span>
        <span className="w-20 text-right">XP</span>
        <span className="w-16 text-right">Fitore</span>
        <span className="w-20 text-right">% fitore</span>
      </div>
      <ul className="space-y-2.5">
        {rows.map((r, i) => {
          const isMe = myId !== null && r.id === myId;
          return (
            <li
              key={r.id}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 border transition-all animate-rise ${
                isMe
                  ? 'border-gold bg-gradient-to-b from-gold/[.14] to-gold/[.04]'
                  : 'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold hover:translate-x-0.5'
              }`}
              style={{ animationDelay: `${Math.min(i, 12) * 0.05}s` }}
            >
              <div className={`w-9 text-center font-display font-bold text-lg ${rankClass(r.rank)}`}>
                {rankLabel(r.rank)}
              </div>
              <div className="pfp shrink-0" style={{ width: 54, height: 54 }}>
                <span className="text-2xl leading-none">{avatarEmoji(r.avatar)}</span>
                <span className="lvl">Niv {r.level}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display font-semibold tracking-wide text-txt truncate">
                  {r.username}
                  {isMe && <span className="ml-2 tag tag-open">Ti</span>}
                </div>
                <div className="text-xs text-muted sm:hidden mt-0.5">
                  {r.xp} XP · {r.wins} fitore · {Math.round(r.winRate * 100)}%
                </div>
              </div>
              <div className="hidden sm:block w-20 text-right font-display font-semibold tracking-wide text-gold-hi">{r.xp}</div>
              <div className="hidden sm:block w-16 text-right font-display font-semibold tracking-wide text-txt">{r.wins}</div>
              <div className="hidden sm:block w-20 text-right font-display font-semibold tracking-wide text-emerald-300">{Math.round(r.winRate * 100)}%</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function RankedBoard({ rows, myId }: { rows: RankedLeaderboardRow[]; myId: string | null }) {
  if (rows.length === 0) {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-2 opacity-60">🃏</div>
        <p className="text-sm text-muted">Ende askush nuk është renditur këtë sezon.</p>
        <p className="text-xs text-muted/70 mt-1">Luaj ndeshje për të fituar MMR dhe për të ngjitur tier-in!</p>
      </div>
    );
  }
  return (
    <>
      <div className="hidden sm:flex items-center gap-3 px-4 pb-2 text-[11px] uppercase tracking-wider text-muted/70">
        <span className="w-9 text-center">#</span>
        <span className="w-[54px]" />
        <span className="flex-1">Lojtari</span>
        <span className="w-28 text-right">MMR</span>
        <span className="w-16 text-right">Lojëra</span>
        <span className="w-20 text-right">% fitore</span>
      </div>
      <ul className="space-y-2.5">
        {rows.map((r, i) => {
          const isMe = myId !== null && r.userId === myId;
          return (
            <li
              key={r.userId}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 border transition-all animate-rise ${
                isMe
                  ? 'border-gold bg-gradient-to-b from-gold/[.14] to-gold/[.04]'
                  : 'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold hover:translate-x-0.5'
              }`}
              style={{ animationDelay: `${Math.min(i, 12) * 0.05}s` }}
            >
              <div className={`w-9 text-center font-display font-bold text-lg ${rankClass(r.rank)}`}>
                {rankLabel(r.rank)}
              </div>
              <div className="pfp shrink-0" style={{ width: 54, height: 54 }}>
                <span className="text-2xl leading-none">{avatarEmoji(r.avatar)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display font-semibold tracking-wide text-txt truncate flex items-center gap-2">
                  <span className="truncate">{r.username}</span>
                  {isMe && <span className="tag tag-open shrink-0">Ti</span>}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <TierBadge tier={r.tier} size="sm" />
                  <span className="text-xs text-muted sm:hidden">{r.rating} MMR · {r.games} lojëra</span>
                </div>
              </div>
              <div className="hidden sm:block w-28 text-right">
                <span className="font-display font-bold tracking-wide text-gold-hi">{r.rating}</span>
                <span className="block text-[10px] text-muted/70">maja {r.peakRating}</span>
              </div>
              <div className="hidden sm:block w-16 text-right font-display font-semibold tracking-wide text-txt">{r.games}</div>
              <div className="hidden sm:block w-20 text-right font-display font-semibold tracking-wide text-emerald-300">{Math.round(r.winRate * 100)}%</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
