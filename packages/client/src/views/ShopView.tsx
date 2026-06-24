import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { rewardsApi, ApiError } from '../lib/api.ts';
import type { RewardsStatus, ShopItem, CosmeticType } from '../lib/api.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useCosmeticsStore } from '../store/cosmeticsStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
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

// A subtle price-tier accent (left edge) so the value spread reads at a glance.
function rarityAccent(cost: number): string {
  if (cost === 0) return 'rgba(255,255,255,0.10)'; // free / default
  if (cost <= 350) return '#9aa4b2';               // common — slate
  if (cost <= 500) return '#5b8cff';               // rare — blue
  return '#b07cff';                                // epic — violet
}

export function ShopView() {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const landscape = useLandscapePage();
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);

  const [status, setStatus] = useState<RewardsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Track a FAILED load distinctly from "logged out": a logged-in user whose status
  // fetch failed must see an inline error + retry, NOT the "log in to open" state.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ tableFelt?: string; cardBack?: string }>({});
  const [priceSort, setPriceSort] = useState<'default' | 'asc' | 'desc'>('default');
  // The previewed cosmetics fall back to whatever is currently equipped.
  const previewFelt = preview.tableFelt ?? status?.equipped.tableFelt ?? '';
  const previewCb = preview.cardBack ?? status?.equipped.cardBack ?? '';

  const load = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) {
      setStatus(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const { status } = await rewardsApi.status(token);
      setStatus(status);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : tr('shop.errLoad'));
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

  // ---- Landscape "console": LEFT = live preview (felt + card-back); RIGHT = item grid
  // grouped by category, sortable by price. Portaled to <body> to escape the ViewTransition transform.
  if (landscape) {
    return createPortal(
      <div className="pg-ls">
        <div className="pg-ls-top">
          <button onClick={() => setView('lobby')} className="btn btn-ghost btn-sm">← {t('common.backToLobby')}</button>
          <h1 className="pg-ls-title gold-text font-display font-bold tracking-wide truncate">{t('shop.title')}</h1>
          <span className="text-sm font-display font-semibold text-gold-hi shrink-0"><CountUp valueCents={balanceCents} /></span>
        </div>

        {loading ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4 text-center py-10"><div className="text-3xl mb-2 opacity-60 animate-pulse">🛍️</div><p className="text-sm text-muted">{t('shop.loading')}</p></div></div>
        ) : loadError ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4 text-center py-10"><div className="text-3xl mb-2 opacity-60">⚠️</div><p className="text-sm text-red-300 mb-3">{loadError}</p><button onClick={() => { setLoading(true); void load(); }} className="btn btn-gold btn-sm">{t('app.retry')}</button></div></div>
        ) : !status ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4 text-center py-10"><div className="text-3xl mb-2 opacity-60">🔒</div><p className="text-sm text-muted">{t('shop.loginToOpen')}</p></div></div>
        ) : !status.enabled ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4 text-center py-10"><div className="text-3xl mb-2 opacity-60">⏸️</div><p className="text-sm text-muted">{t('shop.rewardsDisabled')}</p></div></div>
        ) : (
          <div className="pg-ls-body">
            {/* LEFT — live preview of the focused felt + card-back */}
            <div className="pg-ls-left panel p-3">
              <div className="pg-ls-scroll pr-1 space-y-2">
                <div className={`shop-preview ${previewFelt}`}>
                  <div className={`flex items-end ${previewCb}`}>
                    <span className="shop-cb" style={{ transform: 'rotate(-13deg)', marginRight: -14 }} />
                    <span className="shop-cb" style={{ zIndex: 1, transform: 'translateY(-6px)' }} />
                    <span className="shop-cb" style={{ transform: 'rotate(13deg)', marginLeft: -14 }} />
                  </div>
                </div>
                <p className="text-center text-xs text-muted">{t('shop.previewHint')}</p>
              </div>
            </div>

            {/* RIGHT — item grid grouped by category */}
            <div className="pg-ls-right">
              <div className="flex justify-end mb-1.5">
                <button onClick={() => setPriceSort((s) => (s === 'default' ? 'asc' : s === 'asc' ? 'desc' : 'default'))} className="btn btn-ghost btn-sm">
                  {t('shop.sortPrice')} {priceSort === 'asc' ? '↑' : priceSort === 'desc' ? '↓' : '—'}
                </button>
              </div>
              <div className="pg-ls-scroll pr-1 space-y-3">
                {GROUPS.map((group) => {
                  const base = status.shop.filter((it) => it.type === group.type);
                  const items = priceSort === 'default' ? base : [...base].sort((a, b) => priceSort === 'asc' ? a.cost - b.cost : b.cost - a.cost);
                  if (items.length === 0) return null;
                  return (
                    <section key={group.type} className="panel p-3">
                      <h2 className="text-sm font-display font-semibold text-gold-hi mb-2"><span className="mr-1.5" aria-hidden>{group.icon}</span>{group.title}</h2>
                      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {items.map((item) => (
                          <ShopItemRow
                            key={item.id}
                            item={item}
                            status={status}
                            balanceCents={balanceCents}
                            busy={busyId === item.id}
                            previewFelt={previewFelt}
                            previewCb={previewCb}
                            compact
                            onPreview={() => setPreview((p) => ({ ...p, [item.type]: item.id }))}
                            onBuy={() => void buy(item)}
                            onEquip={() => void equip(item)}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>,
      document.body,
    );
  }

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
      ) : loadError ? (
        /* A failed load must NOT fall through to "log in to open" for a logged-in
           user — show the error + a retry instead. */
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">⚠️</div>
            <p className="text-sm text-red-300 mb-4">{loadError}</p>
            <button onClick={() => { setLoading(true); void load(); }} className="btn btn-gold btn-sm">{t('app.retry')}</button>
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
          {/* Sort-by-price toggle (cycles default → cheapest → priciest). */}
          <div className="flex justify-end -mt-1">
            <button
              onClick={() => setPriceSort((s) => (s === 'default' ? 'asc' : s === 'asc' ? 'desc' : 'default'))}
              className="btn btn-ghost btn-sm"
            >
              {t('shop.sortPrice')} {priceSort === 'asc' ? '↑' : priceSort === 'desc' ? '↓' : '—'}
            </button>
          </div>
          <div className="space-y-5 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start">
          {GROUPS.map((group, gi) => {
          const base = status.shop.filter((it) => it.type === group.type);
          const items = priceSort === 'default' ? base : [...base].sort((a, b) => priceSort === 'asc' ? a.cost - b.cost : b.cost - a.cost);
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
                {items.map((item) => (
                  <ShopItemRow
                    key={item.id}
                    item={item}
                    status={status}
                    balanceCents={balanceCents}
                    busy={busyId === item.id}
                    previewFelt={previewFelt}
                    previewCb={previewCb}
                    onPreview={() => setPreview((p) => ({ ...p, [item.type]: item.id }))}
                    onBuy={() => void buy(item)}
                    onEquip={() => void equip(item)}
                  />
                ))}
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

// One shop item — buy/equip/preview, with owned/equipped/deal states. Shared by the
// portrait list (full) and the landscape grid (`compact` trims paddings/fonts).
interface ShopItemRowProps {
  item: ShopItem;
  status: RewardsStatus;
  balanceCents: number;
  busy: boolean;
  previewFelt: string;
  previewCb: string;
  compact?: boolean;
  onPreview: () => void;
  onBuy: () => void;
  onEquip: () => void;
}

function ShopItemRow({ item, status, balanceCents, busy, previewFelt, previewCb, compact = false, onPreview, onBuy, onEquip }: ShopItemRowProps) {
  const t = useT();
  const isEquipped = status.equipped[item.type] === item.id;
  const isDeal = status.dailyDeal?.id === item.id && !item.owned;
  const price = isDeal ? status.dailyDeal!.priceCents : item.cost;
  const canAfford = balanceCents >= price;
  const btnSize = compact ? 'btn btn-gold btn-sm' : 'btn btn-gold';
  return (
    <li
      style={{ borderLeftColor: rarityAccent(item.cost), borderLeftWidth: item.cost > 0 ? 3 : 1 }}
      className={`flex items-center gap-2.5 rounded-xl border transition-all ${compact ? 'px-2.5 py-2' : 'px-4 py-3'} ${
        isEquipped ? 'border-gold bg-gradient-to-b from-gold/[.14] to-gold/[.04]' : 'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]'
      }`}
    >
      {/* Tap the swatch to preview it on the mini table. */}
      <button
        type="button"
        aria-label={t('shop.previewThis')}
        onClick={onPreview}
        className={`cosmo-swatch ${item.type === 'cardBack' ? 'cardback' : 'felt'} ${item.id} ${
          (item.type === 'tableFelt' ? previewFelt : previewCb) === item.id ? 'is-preview' : ''
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`font-display font-semibold tracking-wide text-txt truncate ${compact ? 'text-sm' : ''}`}>{item.name}</span>
          {item.featured && !item.owned && <span className="tag tag-live shrink-0 text-[10px]">{t('shop.new')}</span>}
          {isDeal && <span className="tag tag-open shrink-0 text-[10px] text-emerald-300">−{status.dailyDeal!.pct}%</span>}
        </div>
        <div className="text-xs text-muted mt-0.5">
          {isDeal ? (
            <>
              <span className="line-through opacity-60 mr-1.5">{costLabel(item.cost)}</span>
              <span className="text-emerald-300 font-semibold">{costLabel(price)}</span>
            </>
          ) : costLabel(item.cost)}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {item.owned ? (
          isEquipped ? (
            <span className="tag tag-open">{t('shop.equipped')}</span>
          ) : (
            <button onClick={onEquip} disabled={busy} className={btnSize}>{busy ? t('shop.equipping') : t('shop.equip')}</button>
          )
        ) : (
          <button onClick={onBuy} disabled={busy || !canAfford} className={btnSize} title={!canAfford ? t('shop.notEnoughBalance') : undefined}>
            {busy ? t('shop.buying') : t('shop.buy')}
          </button>
        )}
      </div>
    </li>
  );
}
