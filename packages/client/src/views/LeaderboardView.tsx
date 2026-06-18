import { useEffect, useState } from 'react';
import { profileApi, rankedApi, ApiError } from '../lib/api.ts';
import type { LeaderboardRow, RankedLeaderboardRow, SeasonDTO } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { AvatarFace } from '../components/ui/AvatarFace.tsx';
import { TierBadge } from '../components/ui/TierBadge.tsx';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

const tr = (key: string) => translate(key, useLangStore.getState().lang);

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
  const t = useT();

  const [tab, setTab] = useState<Tab>('global');
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [ranked, setRanked] = useState<RankedLeaderboardRow[]>([]);
  const [season, setSeason] = useState<SeasonDTO | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setError(null);
    window.scrollTo({ top: 0 }); // tab switch / refresh → show the podium from the top (mobile)
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
        setError(e instanceof ApiError ? e.message : tr('lb.errLoad'));
        setStatus('error');
      });
    return () => { alive = false; };
  }, [tab, reloadKey]);

  return (
    <div className="space-y-5">
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        {t('common.backToLobby')}
      </button>

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('lb.section')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('lb.title')}</h1>
        </div>
        <span className="text-4xl opacity-80">🏆</span>
      </section>

      {/* Tabs: global XP vs ranked season ladder */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab('global')}
          className={`btn flex-1 ${tab === 'global' ? 'btn-gold' : 'btn-ghost'}`}
        >
          🏆 {t('lb.globalTab')}
        </button>
        <button
          onClick={() => setTab('ranked')}
          className={`btn flex-1 ${tab === 'ranked' ? 'btn-gold' : 'btn-ghost'}`}
        >
          👑 {t('lb.rankedTab')}
        </button>
      </div>

      <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">
            {tab === 'global' ? t('lb.globalTable') : t('lb.rankedLadder')}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">
              {tab === 'global'
                ? t('lb.globalSub')
                : season
                  ? t('lb.seasonSub', { n: season.number, name: season.name })
                  : t('lb.rankedSeasonSub')}
            </span>
            <button onClick={refresh} disabled={status === 'loading'} className="btn btn-ghost btn-icon btn-sm" title={t('lb.refresh')} aria-label={t('lb.refresh')}>↻</button>
          </div>
        </div>

        {status === 'loading' ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60 animate-pulse">{tab === 'ranked' ? '👑' : '🏆'}</div>
            <p className="text-sm text-muted">{t('lb.loading')}</p>
          </div>
        ) : status === 'error' ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">⚠️</div>
            <p className="text-sm text-red-300 mb-4">{error}</p>
            <button onClick={refresh} className="btn btn-gold btn-sm">{t('app.retry')}</button>
          </div>
        ) : tab === 'ranked' && !season ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">👑</div>
            <p className="text-sm text-muted">{t('lb.noSeason')}</p>
            <p className="text-xs text-muted/70 mt-1">{t('lb.noSeasonHint')}</p>
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

interface PodiumEntry { id: string; name: string; avatar: string | null; sub: string; isMe: boolean }

/** Top-3 podium: 2nd (left), 1st (centre, raised), 3rd (right) — medals + pedestals. */
function Podium({ top }: { top: PodiumEntry[] }) {
  if (top.length < 3) return null;
  const slots = [
    { e: top[1], place: 2, medal: '🥈', h: 54, accent: '#cdd3da' },
    { e: top[0], place: 1, medal: '🥇', h: 78, accent: '#e8c879' },
    { e: top[2], place: 3, medal: '🥉', h: 36, accent: '#c8884b' },
  ];
  return (
    <div className="panel p-4 mb-3 animate-rise">
      <div className="grid grid-cols-3 gap-2 items-end">
        {slots.map(({ e, place, medal, h, accent }) => (
          <div key={place} className="flex flex-col items-center text-center min-w-0 podium-rise" style={{ animationDelay: `${(3 - place) * 0.08}s` }}>
            <div className="text-xl leading-none mb-1">{medal}</div>
            <div className="pfp" style={{ width: place === 1 ? 60 : 50, height: place === 1 ? 60 : 50, boxShadow: `0 0 0 2px ${accent}, 0 0 16px -2px ${accent}77` }}>
              <AvatarFace id={e.avatar} fill className="text-xl leading-none" />
            </div>
            <div className={`mt-1.5 font-display font-semibold tracking-wide truncate max-w-full ${e.isMe ? 'text-gold-hi' : 'text-txt'} ${place === 1 ? 'text-sm' : 'text-xs'}`} title={e.name}>{e.name}</div>
            <div className="text-[11px] text-gold-hi font-semibold tabular-nums">{e.sub}</div>
            <div
              className="w-full rounded-t-md mt-1.5 flex items-start justify-center pt-1 font-display font-bold leading-none"
              style={{ height: h, background: `linear-gradient(180deg, ${accent}33, ${accent}0a)`, borderTop: `2px solid ${accent}` }}
            >
              <span style={{ color: accent }}>{place}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GlobalBoard({ rows, myId }: { rows: LeaderboardRow[]; myId: string | null }) {
  const t = useT();
  if (rows.length === 0) {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-2 opacity-60">🃏</div>
        <p className="text-sm text-muted">{t('lb.emptyGlobal')}</p>
        <p className="text-xs text-muted/70 mt-1">{t('lb.emptyGlobalHint')}</p>
      </div>
    );
  }
  return (
    <>
      <div className="hidden sm:flex items-center gap-3 px-4 pb-2 text-[11px] uppercase tracking-wider text-muted/70">
        <span className="w-9 text-center">#</span>
        <span className="w-[54px]" />
        <span className="flex-1">{t('lb.player')}</span>
        <span className="w-20 text-right">{t('lb.xp')}</span>
        <span className="w-16 text-right">{t('lb.wins')}</span>
        <span className="w-20 text-right">{t('lb.winPct')}</span>
      </div>
      {rows.length >= 3 && (
        <Podium top={rows.slice(0, 3).map((r) => ({ id: r.id, name: r.username, avatar: r.avatar, sub: `${r.xp} XP`, isMe: myId !== null && r.id === myId }))} />
      )}
      <ul className="space-y-2.5">
        {(rows.length >= 3 ? rows.slice(3) : rows).map((r, i) => {
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
                <AvatarFace id={r.avatar} fill className="text-2xl leading-none" />
                <span className="lvl">{t('lb.level', { n: r.level })}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display font-semibold tracking-wide text-txt truncate">
                  {r.username}
                  {isMe && <span className="ml-2 tag tag-open">{t('lb.you')}</span>}
                </div>
                <div className="text-xs text-muted sm:hidden mt-0.5">
                  {t('lb.globalRowMobile', { xp: r.xp, wins: r.wins, pct: Math.round(r.winRate * 100) })}
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
  const t = useT();
  if (rows.length === 0) {
    return (
      <div className="text-center py-10">
        <div className="text-4xl mb-2 opacity-60">🃏</div>
        <p className="text-sm text-muted">{t('lb.emptyRanked')}</p>
        <p className="text-xs text-muted/70 mt-1">{t('lb.emptyRankedHint')}</p>
      </div>
    );
  }
  return (
    <>
      <div className="hidden sm:flex items-center gap-3 px-4 pb-2 text-[11px] uppercase tracking-wider text-muted/70">
        <span className="w-9 text-center">#</span>
        <span className="w-[54px]" />
        <span className="flex-1">{t('lb.player')}</span>
        <span className="w-28 text-right">{t('lb.mmr')}</span>
        <span className="w-16 text-right">{t('lb.games')}</span>
        <span className="w-20 text-right">{t('lb.winPct')}</span>
      </div>
      {rows.length >= 3 && (
        <Podium top={rows.slice(0, 3).map((r) => ({ id: r.userId, name: r.username, avatar: r.avatar, sub: `${r.rating}`, isMe: myId !== null && r.userId === myId }))} />
      )}
      <ul className="space-y-2.5">
        {(rows.length >= 3 ? rows.slice(3) : rows).map((r, i) => {
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
                <AvatarFace id={r.avatar} fill className="text-2xl leading-none" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display font-semibold tracking-wide text-txt truncate flex items-center gap-2">
                  <span className="truncate">{r.username}</span>
                  {isMe && <span className="tag tag-open shrink-0">{t('lb.you')}</span>}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <TierBadge tier={r.tier} size="sm" />
                  <span className="text-xs text-muted sm:hidden">{t('lb.rankedRowMobile', { rating: r.rating, games: r.games })}</span>
                </div>
              </div>
              <div className="hidden sm:block w-28 text-right">
                <span className="font-display font-bold tracking-wide text-gold-hi">{r.rating}</span>
                <span className="block text-[10px] text-muted/70">{t('lb.peak', { n: r.peakRating })}</span>
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
