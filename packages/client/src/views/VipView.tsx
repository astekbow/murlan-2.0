// VIP / loyalty: your tier (from lifetime staked volume), progress to the next
// tier, and the full ladder with each tier's rake-back rate. Rake-back CASHOUT is
// real money → shown as "coming soon" until a payment provider is wired.
import { useEffect, useState } from 'react';
import { vipApi, ApiError, type VipStatusDTO, type VipTierInfo } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { dollars } from '../lib/money.ts';
import { SkeletonList } from '../components/ui/Skeleton.tsx';
import { useT } from '../lib/i18n.ts';

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
  const [vip, setVip] = useState<VipStatusDTO | null>(null);
  const [tiers, setTiers] = useState<VipTierInfo[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const token = useAuthStore.getState().accessToken;
    Promise.all([token ? vipApi.status(token) : Promise.resolve({ vip: null }), vipApi.tiers()])
      .then(([s, t]) => {
        if (!alive) return;
        setVip((s as { vip: VipStatusDTO | null }).vip);
        setTiers(t.tiers);
        setStatus('ready');
      })
      .catch((e: unknown) => { if (alive) { setError(e instanceof ApiError ? e.message : t('vip.loadFailed')); setStatus('error'); } });
    return () => { alive = false; };
  }, []);

  const pct = vip && vip.next ? Math.min(100, Math.round((vip.stakedCents / vip.next.minStakedCents) * 100)) : 100;

  return (
    <div className="space-y-5">
      <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('vip.loyalty')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">VIP</h1>
        </div>
        <span className="text-4xl opacity-80">♛</span>
      </section>

      {status === 'loading' ? (
        <section className="panel p-5 animate-rise"><SkeletonList count={4} /></section>
      ) : status === 'error' ? (
        <div className="panel p-10 text-center"><div className="text-4xl mb-2 opacity-60">⚠️</div><p className="text-sm text-red-300">{error}</p></div>
      ) : (
        <>
          {vip && (
            <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.05s' }}>
              <div className="flex items-center justify-between gap-3">
                <Badge tier={vip.tier} />
                <span className="text-xs text-muted">{t('vip.volume')} <b className="text-txt">{dollars(vip.stakedCents)}</b></span>
              </div>
              {vip.next ? (
                <>
                  <div className="xpbar" style={{ width: '100%' }}><i style={{ width: `${pct}%` }} /></div>
                  <p className="text-xs text-muted">{t('vip.more')} <b className="text-gold-hi">{dollars(vip.toNextCents)}</b> {t('vip.stakeFor')} <b style={{ color: vip.next.color }}>{vip.next.name}</b>.</p>
                </>
              ) : (
                <p className="text-xs text-emerald-300">{t('vip.maxTier')}</p>
              )}
            </section>
          )}

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
          </section>
        </>
      )}
    </div>
  );
}