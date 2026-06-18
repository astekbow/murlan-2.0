import { useCallback, useEffect, useState } from 'react';
import { rewardsApi, ApiError } from '../lib/api.ts';
import type { RewardsStatus, ShopItem, CosmeticType } from '../lib/api.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useCosmeticsStore } from '../store/cosmeticsStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';
import { dollars } from '../lib/money.ts';
import { CountUp } from '../components/ui/CountUp.tsx';

const tr = (key: string) => translate(key, useLangStore.getState().lang);

const GROUPS: ReadonlyArray<{ type: CosmeticType; title: string; icon: string }> = [
  { type: 'cardBack', title: tr('shop.groupCardBack'), icon: '🂠' },
  { type: 'tableFelt', title: tr('shop.groupTableFelt'), icon: '🟢' },
];

function costLabel(cost: number): string {
  return cost === 0 ? tr('shop.free') : dollars(cost);
}

export function ShopView() {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);

  const [status, setStatus] = useState<RewardsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ tableFelt?: string; cardBack?: string }>({});
  // The previewed cosmetics fall back to whatever is currently equipped.
  const previewFelt = preview.tableFelt ?? status?.equipped.tableFelt ?? '';
  const previewCb = preview.cardBack ?? status?.equipped.cardBack ?? '';

  const load = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const { status } = await rewardsApi.status(token);
      setStatus(status);
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : tr('shop.loadFailed'), toastKind: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buy = async (item: ShopItem) => {
    if (busyId) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusyId(item.id);
    try {
      await rewardsApi.buy(token, item.id);
      useGameStore.setState({ toast: tr('shop.itemBought').replace('{name}', item.name), toastKind: 'success' });
      await load();
      await useAuthStore.getState().refreshMe();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : tr('shop.buyFailed'), toastKind: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const equip = async (item: ShopItem) => {
    if (busyId) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusyId(item.id);
    try {
      await rewardsApi.equip(token, item.id);
      useCosmeticsStore.getState().setEquipped({ [item.type]: item.id });
      useGameStore.setState({ toast: tr('shop.itemEquipped').replace('{name}', item.name), toastKind: 'success' });
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : tr('shop.equipFailed'), toastKind: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Back to lobby */}
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        {t('common.backToLobby')}
      </button>

      {/* Title + XP */}
      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('shop.eyebrow')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('shop.title')}</h1>
        </div>
        {status && (
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted/70">{t('shop.yourBalance')}</div>
            <CountUp valueCents={balanceCents} className="block font-display font-semibold tracking-wide text-gold-hi text-2xl leading-none" />
          </div>
        )}
      </section>

      {loading ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60 animate-pulse">🛍️</div>
            <p className="text-sm text-muted">{t('shop.loading')}</p>
          </div>
        </section>
      ) : !status ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">🔒</div>
            <p className="text-sm text-muted">{t('shop.loginToOpen')}</p>
          </div>
        </section>
      ) : !status.enabled ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">⏸️</div>
            <p className="text-sm text-muted">{t('shop.rewardsDisabled')}</p>
          </div>
        </section>
      ) : (
        <>
          {/* Live preview — the selected felt + card-back on a mini table. */}
          <section className="panel p-4 animate-rise" style={{ animationDelay: '.06s' }}>
            <div className={`shop-preview ${previewFelt}`}>
              <div className={`flex items-end ${previewCb}`}>
                <span className="shop-cb" style={{ transform: 'rotate(-13deg)', marginRight: -14 }} />
                <span className="shop-cb" style={{ zIndex: 1, transform: 'translateY(-6px)' }} />
                <span className="shop-cb" style={{ transform: 'rotate(13deg)', marginLeft: -14 }} />
              </div>
            </div>
            <p className="text-center text-xs text-muted mt-2">{t('shop.previewHint')}</p>
          </section>
          <div className="space-y-5 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start">
          {GROUPS.map((group, gi) => {
          const items = status.shop.filter((it) => it.type === group.type);
          if (items.length === 0) return null;
          return (
            <section
              key={group.type}
              className="panel p-5 animate-rise"
              style={{ animationDelay: `${0.08 + gi * 0.06}s` }}
            >
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">
                <span className="mr-2" aria-hidden>{group.icon}</span>
                {group.title}
              </h2>

              <ul className="space-y-2.5">
                {items.map((item) => {
                  const isEquipped = status.equipped[item.type] === item.id;
                  const canAfford = balanceCents >= item.cost;
                  const busy = busyId === item.id;
                  return (
                    <li
                      key={item.id}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 border transition-all ${
                        isEquipped
                          ? 'border-gold bg-gradient-to-b from-gold/[.14] to-gold/[.04]'
                          : 'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]'
                      }`}
                    >
                      {/* Tap the swatch to preview it on the mini table above. */}
                      <button
                        type="button"
                        aria-label={t('shop.previewThis')}
                        onClick={() => setPreview((p) => ({ ...p, [item.type]: item.id }))}
                        className={`cosmo-swatch ${item.type === 'cardBack' ? 'cardback' : 'felt'} ${item.id} ${
                          (item.type === 'tableFelt' ? previewFelt : previewCb) === item.id ? 'is-preview' : ''
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-semibold tracking-wide text-txt truncate">
                            {item.name}
                          </span>
                        </div>
                        <div className="text-xs text-muted mt-0.5">{costLabel(item.cost)}</div>
                      </div>

                      <div className="ml-auto flex items-center gap-2">
                        {item.owned ? (
                          isEquipped ? (
                            <span className="tag tag-open">{t('shop.equipped')}</span>
                          ) : (
                            <button
                              onClick={() => void equip(item)}
                              disabled={busy}
                              className="btn btn-gold"
                            >
                              {busy ? t('shop.equipping') : t('shop.equip')}
                            </button>
                          )
                        ) : (
                          <button
                            onClick={() => void buy(item)}
                            disabled={busy || !canAfford}
                            className="btn btn-gold"
                            title={!canAfford ? t('shop.notEnoughBalance') : undefined}
                          >
                            {busy ? t('shop.buying') : t('shop.buy')}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
          </div>
        </>
      )}
    </div>
  );
}
