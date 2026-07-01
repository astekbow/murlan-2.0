// VIP / loyalty: your tier (from lifetime staked volume), progress to the next
// tier, and the full ladder with each tier's rake-back rate. Rake-back CASHOUT is
// real money → shown as "coming soon" until a payment provider is wired.
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { vipApi, ApiError, type VipStatusDTO, type VipTierInfo } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { dollars } from '../lib/money.ts';
import { SkeletonList } from '../components/ui/Skeleton.tsx';
import { Confetti } from '../components/ui/Confetti.tsx';
import { sound } from '../lib/sound.ts';
import { haptics } from '../lib/haptics.ts';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

const tr = (key: string) => translate(key, useLangStore.getState().lang);

function Badge({ tier, size = 'md' }: { tier: VipTierInfo; size?: 'sm' | 'md' }) {
  const pad = size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border font-display font-semibold tracking-wide ${pad}`}
      style={{ color: tier.color, borderColor: `${tier.color}66`, background: `${tier.color}1a` }}>
      <span aria-hidden>♛</span>{tier.name}
    </span>
  );
}

export function VipView() {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const landscape = useLandscapePage();
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);
  const [vip, setVip] = useState<VipStatusDTO | null>(null);
  const [tiers, setTiers] = useState<VipTierInfo[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatus('loading');
    setError(null);
    const token = useAuthStore.getState().accessToken;
    Promise.all([token ? vipApi.status(token) : Promise.resolve({ vip: null }), vipApi.tiers()])
      .then(([s, tt]) => {
        setVip((s as { vip: VipStatusDTO | null }).vip);
        setTiers(tt.tiers);
        setStatus('ready');
      })
      // tr() (live-lang) not the t() hook — avoids a stale-closure translation here.
      .catch((e: unknown) => { setError(e instanceof ApiError ? e.message : tr('vip.loadFailed')); setStatus('error'); });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Claim the free weekly VIP gift (server derives the tier — can't be self-granted). On success,
  // celebrate + reload so the gift button hides and the new cosmetic shows up in the shop.
  const [claiming, setClaiming] = useState(false);
  const claimGift = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token || claiming) return;
    setClaiming(true);
    try {
      const res = await vipApi.claimGift(token);
      if (res.ok) {
        sound.play('coin'); haptics.win();
        useGameStore.setState({ toast: res.cosmeticId ? tr('vip.giftGot') : tr('vip.giftGotXp'), toastKind: 'success' });
        load();
      }
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : tr('vip.giftFailed'), toastKind: 'error' });
    } finally {
      setClaiming(false);
    }
  }, [claiming, load]);

  const pct = vip && vip.next ? Math.min(100, Math.round((vip.stakedCents / vip.next.minStakedCents) * 100)) : 100;

  // Tier-up celebration: when the player's tier is HIGHER than the last one we recorded
  // (they climbed since their last visit), fire confetti + a sound. localStorage-backed
  // so it fires once per actual climb, never on a first visit.
  const [celebrate, setCelebrate] = useState(false);
  const [vipTab, setVipTab] = useState<'status' | 'tiers'>('status'); // portrait tabs → no scroll
  useEffect(() => {
    if (status !== 'ready' || !vip || tiers.length === 0) return;
    const rank = tiers.findIndex((x) => x.key === vip.tier.key);
    if (rank < 0) return;
    let prev: number | null = null;
    try { const s = localStorage.getItem('murlan:vipRank'); prev = s === null ? null : Number(s); } catch { /* private mode */ }
    if (prev !== null && rank > prev) {
      setCelebrate(true);
      sound.play('win');
      haptics.win();
      useGameStore.setState({ toast: tr('vip.tierUp'), toastKind: 'success' });
      const id = window.setTimeout(() => setCelebrate(false), 2600);
      try { localStorage.setItem('murlan:vipRank', String(rank)); } catch { /* ignore */ }
      return () => window.clearTimeout(id);
    }
    try { localStorage.setItem('murlan:vipRank', String(rank)); } catch { /* ignore */ }
  }, [status, vip, tiers]);

  // ---- Landscape "console": LEFT = current tier + progress + staked volume;
  // RIGHT = full tier ladder. Portaled to <body> to escape the ViewTransition transform.
  if (landscape) {
    return createPortal(
      <div className="pg-ls">
        {celebrate && <Confetti />}
        <div className="pg-ls-top">
          <button onClick={() => setView('lobby')} className="btn btn-ghost btn-sm">← {t('common.backToLobby')}</button>
          <h1 className="pg-ls-title gold-text font-display font-bold tracking-wide truncate">VIP</h1>
          <span className="text-sm font-display font-semibold text-gold-hi shrink-0">{dollars(balanceCents)}</span>
        </div>

        {status === 'loading' ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4"><SkeletonList count={4} /></div></div>
        ) : status === 'error' ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4 text-center py-10"><div className="text-3xl mb-2 opacity-60">⚠️</div><p className="text-sm text-red-300 mb-3">{error}</p><button onClick={load} className="btn btn-gold btn-sm">{t('app.retry')}</button></div></div>
        ) : (
          <div className="pg-ls-body">
            {/* LEFT — current tier + progress + staked volume */}
            <div className="pg-ls-left panel p-3">
              <div className="pg-ls-scroll pr-1 space-y-3">
                {vip ? (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <Badge tier={vip.tier} />
                    </div>
                    <div className="text-xs text-muted">{t('vip.volume')} <b className="text-txt">{dollars(vip.stakedCents)}</b></div>
                    {vip.next ? (
                      <>
                        <div className="h-2.5 w-full rounded-full bg-black/40 overflow-hidden" role="progressbar" aria-label={t('vip.tierProgress')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ boxShadow: 'inset 0 0 0 1px rgba(232,200,121,0.25)' }}>
                          <i className="block h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--gold), var(--gold-hi))' }} />
                        </div>
                        <p className="text-xs text-muted">{t('vip.more')} <b className="text-gold-hi">{dollars(vip.toNextCents)}</b> {t('vip.stakeFor')} <b style={{ color: vip.next.color }}>{vip.next.name}</b>.</p>
                      </>
                    ) : (
                      <p className="text-xs text-emerald-300">{t('vip.maxTier')}</p>
                    )}
                    {vip.tier.xpBoostBps > 0
                      ? <p className="text-[11px] text-emerald-300">{t('vip.perkXp', { pct: Math.round(vip.tier.xpBoostBps / 100) })}</p>
                      : <p className="text-[11px] text-muted/80">{t('vip.perkLocked')}</p>}
                    {vip.giftAvailable && (
                      <button onClick={() => void claimGift()} disabled={claiming} className={`btn btn-gold btn-block btn-sm ${claiming ? 'btn-loading' : ''}`}>
                        🎁 {claiming ? t('vip.giftClaiming') : t('vip.claimGift')}
                      </button>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted text-center py-6">{t('vip.statusNote')}</p>
                )}
              </div>
            </div>

            {/* RIGHT — full tier ladder */}
            <div className="pg-ls-right">
              <h2 className="text-sm font-display font-semibold text-gold-hi mb-1.5">{t('vip.tiersTitle')}</h2>
              <div className="pg-ls-scroll panel p-3">
                <ul className="space-y-1.5">
                  {tiers.map((t2) => {
                    const isMine = vip?.tier.key === t2.key;
                    return (
                      <li key={t2.key} className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 border ${isMine ? 'border-gold bg-gold/[.10]' : 'border-white/10 bg-white/[.03]'}`}>
                        <Badge tier={t2} size="sm" />
                        {isMine && <span className="tag tag-open text-[11px]">{t('vip.you')}</span>}
                        <span className="text-xs text-muted ml-auto flex items-center gap-2">
                          {t2.xpBoostBps > 0 && <b className="text-emerald-300">+{Math.round(t2.xpBoostBps / 100)}% XP</b>}
                          <span>{t('vip.from')} {dollars(t2.minStakedCents)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] text-muted/70 mt-2">{t('vip.perksNote')}</p>
              </div>
            </div>
          </div>
        )}
      </div>,
      document.getElementById('root') ?? document.body,
    );
  }

  return (
    <div className="space-y-5">
      {celebrate && <Confetti />}
      <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('vip.loyalty')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">VIP</h1>
        </div>
        <span className="text-4xl opacity-80" aria-hidden="true">♛</span>
      </section>

      {status === 'loading' ? (
        <section className="panel p-5 animate-rise"><SkeletonList count={4} /></section>
      ) : status === 'error' ? (
        <div className="panel p-10 text-center">
          <div className="text-4xl mb-2 opacity-60">⚠️</div>
          <p className="text-sm text-red-300 mb-4">{error}</p>
          <button onClick={load} className="btn btn-gold btn-sm">{t('app.retry')}</button>
        </div>
      ) : (
        <>
          {/* Tabs so each part fits the screen without scroll. */}
          <div className="seg grid grid-cols-2" role="group" aria-label="VIP">
            <button type="button" aria-pressed={vipTab === 'status'} onClick={() => setVipTab('status')} className={`seg-tab text-center ${vipTab === 'status' ? 'active' : ''}`}>{t('vip.tabStatus')}</button>
            <button type="button" aria-pressed={vipTab === 'tiers'} onClick={() => setVipTab('tiers')} className={`seg-tab text-center ${vipTab === 'tiers' ? 'active' : ''}`}>{t('vip.tiersTitle')}</button>
          </div>
          {vipTab === 'status' && vip && (
            <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.05s' }}>
              <div className="flex items-center justify-between gap-3">
                <Badge tier={vip.tier} />
                <span className="text-xs text-muted">{t('vip.volume')} <b className="text-txt">{dollars(vip.stakedCents)}</b></span>
              </div>
              {vip.next ? (
                <>
                  <div
                    className="h-2.5 w-full rounded-full bg-black/40 overflow-hidden"
                    role="progressbar" aria-label={t('vip.tierProgress')} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                    style={{ boxShadow: 'inset 0 0 0 1px rgba(232,200,121,0.25)' }}
                  >
                    <i className="block h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, var(--gold), var(--gold-hi))' }} />
                  </div>
                  <p className="text-xs text-muted">{t('vip.more')} <b className="text-gold-hi">{dollars(vip.toNextCents)}</b> {t('vip.stakeFor')} <b style={{ color: vip.next.color }}>{vip.next.name}</b>.</p>
                </>
              ) : (
                <p className="text-xs text-emerald-300">{t('vip.maxTier')}</p>
              )}
              <p className="text-[11px] text-amber-300/90">{t('vip.rakebackSoon')}</p>
            </section>
          )}

          {vipTab === 'tiers' && (
          <section className="panel p-5 animate-rise" style={{ animationDelay: '.1s' }}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('vip.tiersTitle')}</h2>
            </div>
            <ul className="space-y-2.5">
              {tiers.map((t2) => {
                const isMine = vip?.tier.key === t2.key;
                return (
                  <li key={t2.key} className={`flex items-center gap-3 rounded-xl px-4 py-3 border ${isMine ? 'border-gold bg-gradient-to-b from-gold/[.14] to-gold/[.04]' : 'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]'}`}>
                    <Badge tier={t2} size="sm" />
                    {isMine && <span className="tag tag-open">{t('vip.you')}</span>}
                    <span className="text-xs text-muted ml-auto">{t('vip.from')} {dollars(t2.minStakedCents)}</span>
                  </li>
                );
              })}
            </ul>
            <p className="text-[11px] text-muted/70 mt-3">{t('vip.statusNote')}</p>
            <p className="text-[11px] text-muted/70 mt-1">{t('vip.perksNote')}</p>
          </section>
          )}
        </>
      )}
    </div>
  );
}