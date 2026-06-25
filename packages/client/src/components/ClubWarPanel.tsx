// Club War panel (rendered inside ClubsView): founder challenges another club by tag to a
// round-robin series (free or buy-in); members register; each player plays their pairings 1v1
// ("Luaj"); the board shows the aggregate club score + the winner. Polls every 8s for progress.
import { useCallback, useEffect, useState } from 'react';
import { clubWarApi, ApiError, type ClubWarDTO, type ClubDetailDTO } from '../lib/api.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { dollars } from '../lib/money.ts';
import { useT } from '../lib/i18n.ts';

export function ClubWarPanel({ club }: { club: ClubDetailDTO }) {
  const t = useT();
  const myId = useAuthStore((s) => s.user?.id ?? null);
  const isFounder = club.members.find((m) => m.userId === myId)?.role === 'founder';
  const [wars, setWars] = useState<ClubWarDTO[]>([]);
  const [opponentTag, setOpponentTag] = useState('');
  const [paid, setPaid] = useState(false);
  const [stake, setStake] = useState('5');
  const [size, setSize] = useState(2);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try { setWars((await clubWarApi.list(token)).wars); } catch { /* keep last */ }
  }, []);
  useEffect(() => { void load(); const id = window.setInterval(() => void load(), 8000); return () => window.clearInterval(id); }, [load]);

  const act = useCallback(async (fn: (token: string) => Promise<unknown>) => {
    const token = useAuthStore.getState().accessToken;
    if (!token || busy) return;
    setBusy(true);
    try { await fn(token); await load(); }
    catch (e) { useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('clubwar.actionFailed'), toastKind: 'error' }); }
    finally { setBusy(false); }
  }, [busy, load, t]);

  const createWar = () => {
    const tag = opponentTag.trim();
    if (!tag) return;
    void act(async (token) => {
      await clubWarApi.create(token, tag, paid ? Math.round(parseFloat(stake || '0') * 100) : 0, size);
      setOpponentTag('');
    });
  };

  const name = (id: string, w: ClubWarDTO) => w.usernames[id] ?? id.slice(0, 6);

  return (
    <section className="panel p-4 animate-rise space-y-3">
      <h2 className="font-display font-semibold tracking-wide text-gold-hi text-sm flex items-center gap-1.5">⚔️ {t('clubwar.title')}</h2>

      {/* Create (founder only) */}
      {isFounder && (
        <div className="rounded-xl border border-white/10 bg-white/[.03] p-3 space-y-2">
          <p className="text-xs text-muted">{t('clubwar.challengeHint')}</p>
          <div className="flex gap-2">
            <input className="field flex-1" value={opponentTag} onChange={(e) => setOpponentTag(e.target.value.toUpperCase())} placeholder={t('clubwar.opponentTag')} maxLength={5} />
            <select className="field w-20" value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label={t('clubwar.size')}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}v{n}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> {t('clubwar.withStake')}</label>
            {paid && <input className="field w-24" type="number" min="0" step="0.5" value={stake} onChange={(e) => setStake(e.target.value)} aria-label={t('clubwar.stake')} />}
            <button onClick={createWar} disabled={busy || !opponentTag.trim()} className="btn btn-gold btn-sm ml-auto">{t('clubwar.challenge')}</button>
          </div>
        </div>
      )}

      {wars.length === 0 ? (
        <p className="text-sm text-muted text-center py-3">{t('clubwar.none')}</p>
      ) : (
        <ul className="space-y-2.5">
          {wars.map((w) => {
            const amClubA = club.id === w.clubAId;
            const registered = !!myId && (w.rosterA.includes(myId) || w.rosterB.includes(myId));
            const myRoster = amClubA ? w.rosterA : w.rosterB;
            const canRegister = w.status === 'registering' && !registered && myRoster.length < w.size;
            const wonByMyClub = w.winnerClubId === club.id;
            return (
              <li key={w.id} className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] p-3 space-y-2">
                {/* Scoreboard */}
                <div className="flex items-center justify-center gap-3 font-display font-semibold">
                  <span className="text-txt">{w.clubATag}</span>
                  <span className="text-2xl text-gold-hi tabular-nums">{w.scoreA} – {w.scoreB}</span>
                  <span className="text-txt">{w.clubBTag}</span>
                </div>
                <div className="flex items-center justify-center gap-2 text-[11px] text-muted">
                  <span className="tag">{t(`clubwar.status.${w.status}`)}</span>
                  {w.stakeCents > 0 ? <span>💰 {dollars(w.prizePoolCents)}</span> : <span>{t('clubwar.free')}</span>}
                  <span>{w.rosterA.length}/{w.size} · {w.rosterB.length}/{w.size}</span>
                </div>

                {w.status === 'finished' && (
                  <p className={`text-center text-sm font-semibold ${wonByMyClub ? 'text-emerald-300' : w.winnerClubId ? 'text-suit' : 'text-muted'}`}>
                    {w.winnerClubId ? t('clubwar.clubWon', { tag: w.winnerClubId === w.clubAId ? w.clubATag : w.clubBTag }) : t('clubwar.tie')}
                  </p>
                )}

                {/* Pairings */}
                {w.pairings.length > 0 && (
                  <ul className="space-y-1 pt-1 border-t border-white/5">
                    {w.pairings.map((p, i) => {
                      const iAmIn = myId === p.aUserId || myId === p.bUserId;
                      const opp = myId === p.aUserId ? p.bUserId : p.aUserId;
                      return (
                        <li key={i} className="flex items-center gap-2 text-xs">
                          <span className={`flex-1 truncate ${p.winnerId === p.aUserId ? 'text-emerald-300' : 'text-txt'}`}>{name(p.aUserId, w)}</span>
                          <span className="text-muted/60">vs</span>
                          <span className={`flex-1 truncate text-right ${p.winnerId === p.bUserId ? 'text-emerald-300' : 'text-txt'}`}>{name(p.bUserId, w)}</span>
                          {p.winnerId ? (
                            <span className="text-emerald-300 shrink-0">🏆</span>
                          ) : iAmIn && w.status === 'running' ? (
                            <button onClick={() => void useGameStore.getState().playClubWar(w.id, opp)} disabled={busy} className="btn btn-gold btn-sm shrink-0">{t('clubwar.play')}</button>
                          ) : <span className="text-muted/40 shrink-0">·</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-1">
                  {canRegister && <button onClick={() => void act((token) => clubWarApi.register(token, w.id))} disabled={busy} className="btn btn-gold btn-sm">{t('clubwar.register')}</button>}
                  {registered && w.status === 'registering' && <span className="text-xs text-emerald-300 self-center">{t('clubwar.registered')}</span>}
                  {isFounder && w.status === 'registering' && <button onClick={() => void act((token) => clubWarApi.start(token, w.id))} disabled={busy} className="btn btn-ghost btn-sm">{t('clubwar.start')}</button>}
                  {isFounder && (w.status === 'registering' || w.status === 'running') && <button onClick={() => void act((token) => clubWarApi.cancel(token, w.id))} disabled={busy} className="btn btn-ghost btn-sm ml-auto">{t('clubwar.cancel')}</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
