// Read-only spectator view: renders the SAME public, hands-hidden state players
// see — seats with card COUNTS (never cards), the pile, whose turn it is, the
// scoreboard, and the result. No controls, no hand. Deliberately a separate lean
// view (not the player table) so a watcher can never act or see private cards.
import { useShallow } from 'zustand/react/shallow';
import type { RoomStateDTO } from '@murlan/shared';
import { useGameStore } from '../store/gameStore.ts';
import { Pile } from '../components/Pile.tsx';
import { sound } from '../lib/sound.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

const tr = (key: string) => translate(key, useLangStore.getState().lang);

const TYPE_LABEL: Record<string, string> = { '1v1': tr('spectate.type1v1'), '1v1v1': '1v1v1', '2v2': tr('spectate.type2v2') };

export function SpectateView({ room }: { room: RoomStateDTO }) {
  const t = useT();
  const { game, scoreboard, matchResult, stopSpectate } = useGameStore(
    useShallow((s) => ({ game: s.game, scoreboard: s.scoreboard, matchResult: s.matchResult, stopSpectate: s.stopSpectate })),
  );
  const nameOf = (seat: number) => room.seats[seat]?.username ?? t('spectate.seatN', { n: seat + 1 });
  const turn = game?.turn ?? null;
  const passed = new Set(game?.passed ?? []);
  const finished = new Set(game?.finishingOrder ?? []);
  const leave = () => { sound.play('button'); stopSpectate(); };

  return (
    // Renders outside the lobby Shell → inset for the iPhone notch (audit finding H10).
    <div
      className="relative z-10 mx-auto w-full max-w-[680px] pb-6 space-y-4"
      style={{
        paddingTop: 'calc(0.75rem + env(safe-area-inset-top))',
        paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
      }}
    >
      <h1 className="sr-only">{t('spectate.srWatchingLive')}</h1>
      <div className="flex items-center justify-between gap-3 animate-rise">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-2xl">👁</span>
          <div className="min-w-0">
            <div className="font-display font-semibold text-gold-hi tracking-wide">{t('spectate.watching')}</div>
            <div className="text-xs text-muted truncate">{TYPE_LABEL[room.type] ?? room.type} · {t('spectate.objective', { target: room.target })}</div>
          </div>
        </div>
        <button onClick={leave} className="btn btn-ghost shrink-0">{t('spectate.leave')}</button>
      </div>

      {/* Seats — usernames + card COUNTS only, turn highlighted */}
      <section className="panel p-4 space-y-2 animate-rise" style={{ animationDelay: '.05s' }}>
        {room.seats.map((s, i) => (
          <div key={i} className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 border transition-colors ${turn === i ? 'border-gold bg-gold/[.08]' : 'border-white/10'}`}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-display font-semibold truncate">{nameOf(i)}</span>
              {room.type === '2v2' && s.team != null && <span className="text-[10px] text-muted">{t('spectate.teamShort', { n: s.team + 1 })}</span>}
              {turn === i && <span className="tag tag-live"><span className="pls" />{t('spectate.turn')}</span>}
              {passed.has(i) && <span className="text-[10px] text-muted">{t('spectate.passed')}</span>}
              {finished.has(i) && <span className="text-[10px] text-emerald-300">{t('spectate.finished')}</span>}
            </div>
            <div className="text-sm text-muted shrink-0">{game ? t('spectate.cards', { n: game.handCounts[i] ?? 0 }) : (s.connected ? t('spectate.ready') : t('spectate.offline'))}</div>
          </div>
        ))}
      </section>

      {/* Pile in the centre */}
      <section className="panel p-5 min-h-[128px] grid place-items-center animate-rise" style={{ animationDelay: '.1s' }}>
        <Pile pile={game?.pile ?? null} />
      </section>

      {/* Live scoreboard */}
      {scoreboard && (
        <section className="panel p-4 animate-rise" style={{ animationDelay: '.15s' }}>
          <div className="font-serif text-[10px] tracking-[0.25em] text-muted uppercase mb-2">{t('spectate.score')} · {t('spectate.objective', { target: scoreboard.target })}</div>
          <div className="space-y-1">
            {scoreboard.type === '2v2' && scoreboard.teamTotals
              ? ([0, 1] as const).map((t2) => (
                  <div key={t2} className="flex justify-between text-sm"><span>{t('spectate.team', { n: t2 + 1 })}</span><b className="text-gold-hi">{scoreboard.teamTotals![t2]}</b></div>
                ))
              : scoreboard.cumulative.map((pts, seat) => (
                  <div key={seat} className="flex justify-between text-sm"><span className="truncate max-w-[220px]">{nameOf(seat)}</span><b className="text-gold-hi">{pts}</b></div>
                ))}
          </div>
        </section>
      )}

      {/* Match-end */}
      {matchResult && (
        <div className="modal-backdrop !z-[60]" role="dialog" aria-modal="true" aria-label={t('spectate.matchOver')}>
          <div className="panel-solid w-full max-w-sm p-7 text-center animate-pop">
            <div className="text-5xl mb-2">🏆</div>
            <h2 className="gold-text font-display font-bold tracking-wide text-2xl mb-1">{t('spectate.matchOverTitle')}</h2>
            <p className="text-sm text-muted mb-5">
              {t('spectate.won', { names: matchResult.winnerSeats.map((s) => nameOf(s)).join(' & ') || '—' })}
            </p>
            <button autoFocus onClick={leave} className="btn btn-gold btn-lg btn-block">{t('spectate.leave')}</button>
          </div>
        </div>
      )}
    </div>
  );
}