import { useEffect, useState } from 'react';
import { profileApi, ApiError } from '../lib/api.ts';
import type { LeaderboardRow } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { avatarEmoji } from '../lib/avatars.ts';

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

export function LeaderboardView() {
  const setView = useUiStore((s) => s.setView);
  const myId = useAuthStore((s) => s.user?.id) ?? null;

  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    profileApi
      .leaderboard()
      .then(({ rows }) => {
        if (!alive) return;
        setRows(rows);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : 'Klasifikimi nuk u ngarkua.');
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-5">
      {/* Back to lobby */}
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        ← Kthehu te lobi
      </button>

      {/* Title */}
      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">RENDITJA</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">KLASIFIKIMI</h1>
        </div>
        <span className="text-4xl opacity-80">🏆</span>
      </section>

      {/* Board */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">TABELA GLOBALE</h2>
          <span className="text-xs text-muted">Renditja globale sipas XP-së</span>
        </div>

        {status === 'loading' ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60 animate-pulse">🏆</div>
            <p className="text-sm text-muted">Po ngarkohet klasifikimi…</p>
          </div>
        ) : status === 'error' ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">⚠️</div>
            <p className="text-sm text-red-300">{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">🃏</div>
            <p className="text-sm text-muted">Ende nuk ka lojtarë në klasifikim.</p>
            <p className="text-xs text-muted/70 mt-1">Luaj ndeshje për të fituar XP dhe për t'u renditur!</p>
          </div>
        ) : (
          <>
            {/* Column header */}
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
                    {/* Rank */}
                    <div className={`w-9 text-center font-display font-bold text-lg ${rankClass(r.rank)}`}>
                      {rankLabel(r.rank)}
                    </div>

                    {/* Avatar + level badge */}
                    <div className="pfp shrink-0" style={{ width: 54, height: 54 }}>
                      <span className="text-2xl leading-none">{avatarEmoji(r.avatar)}</span>
                      <span className="lvl">Niv {r.level}</span>
                    </div>

                    {/* Name */}
                    <div className="flex-1 min-w-0">
                      <div className="font-display font-semibold tracking-wide text-txt truncate">
                        {r.username}
                        {isMe && <span className="ml-2 tag tag-open">Ti</span>}
                      </div>
                      <div className="text-xs text-muted sm:hidden mt-0.5">
                        {r.xp} XP · {r.wins} fitore · {Math.round(r.winRate * 100)}%
                      </div>
                    </div>

                    {/* Stat columns (desktop) */}
                    <div className="hidden sm:block w-20 text-right font-display font-semibold tracking-wide text-gold-hi">
                      {r.xp}
                    </div>
                    <div className="hidden sm:block w-16 text-right font-display font-semibold tracking-wide text-txt">
                      {r.wins}
                    </div>
                    <div className="hidden sm:block w-20 text-right font-display font-semibold tracking-wide text-emerald-300">
                      {Math.round(r.winRate * 100)}%
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
