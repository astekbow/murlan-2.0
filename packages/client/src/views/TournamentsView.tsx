// Tournaments: list, register (escrows your buy-in), and watch the bracket. Admins
// create tournaments, report each pairing's winner (advances the bracket; the final
// pays the pool − 10% rake), and can cancel (refunds everyone) while registering.
import { useCallback, useEffect, useState } from 'react';
import { tournamentsApi, ApiError, type TournamentDTO } from '../lib/api.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { dollars } from '../lib/money.ts';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

const tr = (k: string) => translate(k, useLangStore.getState().lang);
const tk = () => useAuthStore.getState().accessToken;

export function TournamentsView() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const setView = useUiStore((s) => s.setView);
  const me = useAuthStore((s) => s.user);
  const isAdmin = me?.role === 'admin';
  const [list, setList] = useState<TournamentDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('Turne');
  const [buyIn, setBuyIn] = useState('5');
  const [cap, setCap] = useState<2 | 4 | 8>(4);
  // Distinguish loading / loaded-and-empty / failed so a failed fetch shows an inline
  // error + retry instead of the "no tournaments" empty state.
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const token = tk();
    if (!token) { setStatus('ready'); return; }
    if (!opts?.silent) { setStatus('loading'); setError(null); }
    try {
      setList((await tournamentsApi.list(token)).tournaments);
      setStatus('ready');
    } catch (e) {
      // A post-action silent refresh that blips keeps the current list (the action's
      // own toast covers it); the initial/explicit load surfaces the error state.
      if (opts?.silent) return;
      setError(e instanceof ApiError ? e.message : tr('tourn.loadFailed'));
      setStatus('error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    const token = tk();
    if (!token || busy) return;
    setBusy(true);
    try { await fn(); await load({ silent: true }); await useAuthStore.getState().refreshMe(); }
    catch (e) { useGameStore.setState({ toast: e instanceof ApiError ? e.message : tr('tourn.actionFailed'), toastKind: 'error' }); }
    finally { setBusy(false); }
  };

  const label = (uid: string | null) => (uid == null ? '—' : uid === me?.id ? t('tourn.you') : uid.slice(0, 6));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>
        {dialog}
        <button onClick={() => void load()} className="btn btn-ghost">{t('common.refresh')}</button>
      </div>
      <section className="panel p-5 animate-rise text-center">
        <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('tourn.eyebrow')}</div>
        <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('tourn.title')}</h1>
      </section>

      {/* ANY player can open a tournament — it runs itself (the bracket plays in the
          live game) and the house takes its rake at the final. */}
      <section className="panel p-5 animate-rise space-y-3">
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('tourn.create')}</h2>
        <form className="flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); if (busy) return; void act(() => tournamentsApi.create(tk()!, name.trim() || 'Turne', Math.round((parseFloat(buyIn) || 0) * 100), cap)); }}>
          <label className="flex-1 min-w-[140px]"><span className="field-label">{t('tourn.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="field" /></label>
          <label><span className="field-label">{t('tourn.buyIn')} ($)</span>
            <input type="number" min="0" step="1" value={buyIn} onChange={(e) => setBuyIn(e.target.value)} className="field w-24" /></label>
          <label><span className="field-label">{t('tourn.players')}</span>
            <select value={cap} onChange={(e) => setCap(Number(e.target.value) as 2 | 4 | 8)} className="field w-20">
              <option value={2}>2</option><option value={4}>4</option><option value={8}>8</option>
            </select></label>
          <button type="submit" disabled={busy} className="btn btn-gold">{t('tourn.create')}</button>
        </form>
      </section>

      {status === 'loading' ? (
        <section className="panel p-8 text-center"><div className="text-4xl mb-2 opacity-60 animate-pulse">🏆</div><p className="text-sm text-muted">{t('tourn.loading')}</p></section>
      ) : status === 'error' ? (
        <section className="panel p-8 text-center">
          <div className="text-4xl mb-2 opacity-60">⚠️</div>
          <p className="text-sm text-red-300 mb-4">{error}</p>
          <button onClick={() => void load()} className="btn btn-gold btn-sm">{t('app.retry')}</button>
        </section>
      ) : list.length === 0 ? (
        <section className="panel p-8 text-center"><div className="text-4xl mb-2 opacity-60" aria-hidden="true">🏆</div><p className="text-sm text-muted">{t('tourn.none')}</p></section>
      ) : (
        list.map((tn) => {
          const joined = me ? tn.playerIds.includes(me.id) : false;
          const canRegister = tn.status === 'registering' && !joined && tn.playerIds.length < tn.capacity;
          const rounds = [...new Set(tn.bracket.map((m) => m.round))].sort((a, b) => a - b);
          return (
            <section key={tn.id} className="panel p-5 animate-rise space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <h3 className="font-display font-semibold tracking-wide text-gold-hi text-lg">{tn.name}</h3>
                  <div className="text-xs text-muted">
                    {t('tourn.buyIn')}: <b className="text-txt">{dollars(tn.buyInCents)}</b> · {t('tourn.prize')}: <b className="text-gold-hi">{dollars(tn.prizePoolCents)}</b> · {tn.playerIds.length}/{tn.capacity} 👥
                  </div>
                </div>
                <span className="tag tag-open">{t(`tourn.status.${tn.status}`)}</span>
              </div>

              {canRegister && <button disabled={busy} onClick={() => void act(() => tournamentsApi.register(tk()!, tn.id))} className="btn btn-gold btn-block">{t('tourn.register')} · {dollars(tn.buyInCents)}</button>}
              {joined && tn.status === 'registering' && <p className="text-xs text-emerald-300 text-center">{t('tourn.registered')}</p>}
              {isAdmin && tn.status === 'registering' && <button disabled={busy} onClick={async () => { if (await confirm({ title: t('tourn.cancelRefund'), message: t('tourn.confirmCancelM'), danger: true, confirmLabel: t('tourn.cancelRefund') })) void act(() => tournamentsApi.cancel(tk()!, tn.id)); }} className="btn btn-danger btn-block">{t('tourn.cancelRefund')}</button>}
              {/* Dual-control: a parked champion awaits a SECOND admin's confirmation before payout. */}
              {isAdmin && tn.status === 'awaiting_confirmation' && (
                <div className="space-y-1.5 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2.5">
                  <p className="text-xs text-amber-300 text-center">{t('tourn.awaitingConfirm')}{tn.pendingWinnerId ? `: ${label(tn.pendingWinnerId)}` : ''}</p>
                  <button disabled={busy} onClick={async () => { if (await confirm({ title: t('tourn.confirmPayout'), message: t('tourn.confirmPayoutM'), confirmLabel: t('tourn.confirmPayout') })) void act(() => tournamentsApi.confirm(tk()!, tn.id)); }} className="btn btn-gold btn-block">{t('tourn.confirmPayout')}</button>
                  <button disabled={busy} onClick={async () => { if (await confirm({ title: t('tourn.cancelRefund'), message: t('tourn.confirmCancelM'), danger: true, confirmLabel: t('tourn.cancelRefund') })) void act(() => tournamentsApi.cancel(tk()!, tn.id)); }} className="btn btn-danger btn-block">{t('tourn.cancelRefund')}</button>
                </div>
              )}
              {tn.winnerId && tn.status === 'finished' && <p className="text-sm text-center text-gold-hi">🏆 {t('tourn.champion')}: {label(tn.winnerId)}</p>}

              {rounds.length > 0 && (
                <div className="space-y-2.5">
                  {rounds.map((round) => (
                    <div key={round}>
                      <div className="text-[11px] uppercase tracking-wider text-muted/70 mb-1">{t('tourn.round')} {round + 1}</div>
                      <ul className="space-y-1.5">
                        {tn.bracket.filter((m) => m.round === round).sort((a, b) => a.index - b.index).map((m) => (
                          <li key={m.index} className="flex items-center gap-2 rounded-lg px-3 py-2 border border-white/10 bg-white/[.03] text-sm">
                            <span className={m.winnerId === m.aUserId ? 'text-emerald-300 font-semibold' : 'text-txt'}>{label(m.aUserId)}</span>
                            <span className="text-muted text-xs">vs</span>
                            <span className={m.winnerId === m.bUserId ? 'text-emerald-300 font-semibold' : 'text-txt'}>{label(m.bUserId)}</span>
                            {isAdmin && tn.status === 'running' && !m.winnerId && m.aUserId && m.bUserId && (
                              <span className="ml-auto flex gap-1.5">
                                <button disabled={busy} onClick={() => void act(() => tournamentsApi.report(tk()!, tn.id, m.round, m.index, m.aUserId!))} className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: 12 }}>{label(m.aUserId)} ✓</button>
                                <button disabled={busy} onClick={() => void act(() => tournamentsApi.report(tk()!, tn.id, m.round, m.index, m.bUserId!))} className="btn btn-ghost" style={{ padding: '3px 8px', fontSize: 12 }}>{label(m.bUserId)} ✓</button>
                              </span>
                            )}
                            {m.winnerId && <span className="ml-auto text-xs text-gold-hi">🏆 {label(m.winnerId)}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
