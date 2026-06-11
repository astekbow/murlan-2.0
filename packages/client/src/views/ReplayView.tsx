// Provably-fair replay + verifier. Fetches a match's deal seeds + move-log, then
// IN THE BROWSER: (1) checks the revealed serverSeed against the committed hash,
// (2) recomputes every deal from the seeds (via the shared engine), and (3) lists
// every move in turn order. Public + self-contained so a ?replay=<id> link works
// for anyone, signed in or not.
import { useEffect, useMemo, useState } from 'react';
import type { Card } from '@murlan/engine';
import { replayApi, ApiError, type ReplayDTO, type ReplayActionDTO } from '../lib/api.ts';
import { cardLabel, isRed } from '../lib/cards.ts';
import { reconstructDeal, verifyCommitment } from '../lib/fairVerify.ts';
import { useT } from '../lib/i18n.ts';

type VerifyState = 'pending' | 'ok' | 'mismatch' | 'unrevealed';

function CardChip({ card }: { card: Card }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md border px-1.5 py-0.5 text-xs font-display font-semibold ${
        isRed(card) ? 'text-rose-300 border-rose-400/40 bg-rose-500/10' : 'text-txt border-white/15 bg-white/[.05]'
      }`}
    >
      {cardLabel(card)}
    </span>
  );
}

function ActionRow({ a }: { a: ReplayActionDTO }) {
  const t = useT();
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-white/5 last:border-0">
      <span className="shrink-0 text-xs text-muted font-display w-16">{t('replay.seatN', { n: a.seat + 1 })}</span>
      <div className="flex-1 flex flex-wrap items-center gap-1">
        {a.type === 'pass' ? (
          <span className="text-xs text-muted italic">{t('replay.pass')}</span>
        ) : a.type === 'switch' ? (
          <>
            <span className="text-xs text-amber-300/80">{t('replay.switched')}</span>
            {a.cards?.map((c, i) => <CardChip key={i} card={c} />)}
          </>
        ) : (
          a.cards?.map((c, i) => <CardChip key={i} card={c} />)
        )}
      </div>
    </div>
  );
}

export function ReplayView({ matchId, onClose }: { matchId: string; onClose: () => void }) {
  const t = useT();
  const [dto, setDto] = useState<ReplayDTO | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyState>('pending');
  const [hands, setHands] = useState<Record<number, Card[][]>>({});

  useEffect(() => {
    let alive = true;
    setStatus('loading'); setError(null); setVerify('pending'); setHands({}); setDto(null);
    replayApi
      .get(matchId)
      .then(async (d) => {
        if (!alive) return;
        setDto(d);
        setStatus('ready');
        const serverSeed = d.games[0]?.serverSeed ?? null;
        if (!d.revealed || !serverSeed) { setVerify('unrevealed'); return; }
        const ok = await verifyCommitment(serverSeed, d.serverSeedHash ?? '');
        if (!alive) return;
        setVerify(ok ? 'ok' : 'mismatch');
        if (ok && d.clientSeed) {
          const recon: Record<number, Card[][]> = {};
          for (const g of d.games) {
            if (g.serverSeed) recon[g.index] = await reconstructDeal(g.serverSeed, d.clientSeed, g.nonce, d.numPlayers);
          }
          if (alive) setHands(recon);
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError && e.status === 404 ? t('replay.errNotFound') : e instanceof ApiError ? e.message : t('replay.errLoad'));
        setStatus('error');
      });
    return () => { alive = false; };
  }, [matchId]);

  const byGame = useMemo(() => {
    const m = new Map<number, ReplayActionDTO[]>();
    for (const a of dto?.actions ?? []) {
      const arr = m.get(a.gameIndex) ?? [];
      arr.push(a);
      m.set(a.gameIndex, arr);
    }
    return m;
  }, [dto]);

  const gameIndices = useMemo(() => {
    const set = new Set<number>();
    for (const g of dto?.games ?? []) set.add(g.index);
    for (const k of byGame.keys()) set.add(k);
    return [...set].sort((a, b) => a - b);
  }, [dto, byGame]);

  return (
    <div
      className="relative z-10 mx-auto w-full max-w-[900px] space-y-5"
      style={{
        paddingTop: 'max(1rem, env(safe-area-inset-top))',
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
        paddingBottom: 'calc(3.5rem + env(safe-area-inset-bottom))',
      }}
    >
      <button onClick={onClose} className="btn btn-ghost">{t('replay.back')}</button>

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">PROVABLY FAIR</div>
          <h1 className="gold-text font-display font-bold text-2xl tracking-wide leading-none">{t('replay.title')}</h1>
          <div className="text-xs text-muted mt-1.5 font-mono truncate">{matchId}</div>
        </div>
        <span className="text-4xl opacity-80">🔁</span>
      </section>

      {status === 'loading' ? (
        <div className="panel p-10 text-center"><div className="text-4xl mb-2 opacity-60 animate-pulse">🔁</div><p className="text-sm text-muted">{t('replay.loading')}</p></div>
      ) : status === 'error' ? (
        <div className="panel p-10 text-center"><div className="text-4xl mb-2 opacity-60">⚠️</div><p className="text-sm text-red-300">{error}</p></div>
      ) : dto ? (
        <>
          {/* Verification verdict */}
          <section className="panel p-5 animate-rise" style={{ animationDelay: '.05s' }}>
            {verify === 'ok' ? (
              <div className="flex items-start gap-3">
                <span className="text-2xl">✅</span>
                <div>
                  <div className="font-display font-semibold text-emerald-300">{t('replay.verifiedOk')}</div>
                  <p className="text-xs text-muted mt-1">{t('replay.verifiedOkBody')}</p>
                </div>
              </div>
            ) : verify === 'mismatch' ? (
              <div className="flex items-start gap-3">
                <span className="text-2xl">❌</span>
                <div>
                  <div className="font-display font-semibold text-red-300">{t('replay.mismatch')}</div>
                  <p className="text-xs text-muted mt-1">{t('replay.mismatchBody')}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <span className="text-2xl">⏳</span>
                <div>
                  <div className="font-display font-semibold text-amber-300">{t('replay.unrevealed')}</div>
                  <p className="text-xs text-muted mt-1">{t('replay.unrevealedBody')}</p>
                </div>
              </div>
            )}

            {/* Seeds (the audit material) */}
            <div className="mt-4 space-y-1.5 text-[11px] font-mono break-all">
              <SeedRow label="serverSeedHash" value={dto.serverSeedHash} />
              <SeedRow label="serverSeed" value={dto.games[0]?.serverSeed ?? null} muted={!dto.revealed} />
              <SeedRow label="clientSeed" value={dto.clientSeed} />
            </div>
          </section>

          {gameIndices.length === 0 ? (
            <div className="panel p-10 text-center"><div className="text-4xl mb-2 opacity-60">🃏</div><p className="text-sm text-muted">{t('replay.noMoves')}</p></div>
          ) : (
            gameIndices.map((gi, n) => (
              <section key={gi} className="panel p-5 animate-rise" style={{ animationDelay: `${0.08 + Math.min(n, 8) * 0.04}s` }}>
                <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('replay.gameN', { n: gi + 1 })}</h2>

                {hands[gi] && (
                  <div className="space-y-2 mb-4">
                    <div className="font-serif text-[10px] tracking-[0.2em] text-muted uppercase">{t('replay.reconstructedDeal')}</div>
                    {hands[gi]!.map((hand, seat) => (
                      <div key={seat} className="flex items-start gap-2">
                        <span className="shrink-0 text-xs text-muted font-display w-16 pt-0.5">{t('replay.seatN', { n: seat + 1 })}</span>
                        <div className="flex-1 flex flex-wrap gap-1">
                          {hand.map((c, i) => <CardChip key={i} card={c} />)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="font-serif text-[10px] tracking-[0.2em] text-muted uppercase mb-1">{t('replay.moves')}</div>
                {(byGame.get(gi) ?? []).length === 0 ? (
                  <p className="text-xs text-muted/70 italic">—</p>
                ) : (
                  <div>{(byGame.get(gi) ?? []).map((a) => <ActionRow key={a.seq} a={a} />)}</div>
                )}
              </section>
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

function SeedRow({ label, value, muted }: { label: string; value: string | null; muted?: boolean }) {
  const t = useT();
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-muted/70 w-28">{label}</span>
      <span className={muted ? 'text-muted/50 italic' : 'text-muted'}>{value ?? t('replay.unpublished')}</span>
    </div>
  );
}
