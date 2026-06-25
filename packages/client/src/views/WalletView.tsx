import { useEffect, useRef, useState } from 'react';
import { useWalletStore } from '../store/walletStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { accountApi, walletApi, ApiError, type RgLimits } from '../lib/api.ts';
import { dollars, parseDollarsToCents, txLabel } from '../lib/money.ts';
import { CountUp } from '../components/ui/CountUp.tsx';
import { Confetti } from '../components/ui/Confetti.tsx';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { sound } from '../lib/sound.ts';
import { haptics } from '../lib/haptics.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

/** For errors set OUTSIDE React render (store.setState) — translate with the live lang. */
const tr = (key: string) => translate(key, useLangStore.getState().lang);

const WITHDRAW_FEE_CENTS = 100; // ~1 USDT network/Binance fee deducted from the sent amount
/** Cheap client-side TRON address shape check (T + 33 base58 chars) for live ✓/✗ feedback;
 *  the server still does the real checksum validation before any payout. */
const isLikelyTron = (a: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a.trim());

/** Prominent, repeated "TRON-only / wrong network = lost funds" card. Crypto sends are
 *  irreversible, so this is a bordered badge at the top of deposit AND withdraw — not a
 *  muted footnote that's easy to skip. */
function TronWarning() {
  const t = useT();
  return (
    <div className="flex items-start gap-2 rounded-xl border border-amber-400/50 bg-amber-500/10 px-3 py-2.5">
      <span aria-hidden className="text-base leading-none">⚠️</span>
      <p className="text-[12px] font-medium text-amber-200 leading-snug">{t('wallet.networkWarn')}</p>
    </div>
  );
}

export function WalletView() {
  const {
    balanceCents, transactions, withdrawals, profile, error, notice, loading,
    refresh, withdraw, setProfile, selfExclude, clearMessages,
  } = useWalletStore();
  const setView = useUiStore((s) => s.setView);
  const t = useT();
  const { confirm, dialog } = useConfirm();

  // Show skeleton placeholders only on the FIRST load (blank → data). Once a load has
  // ever completed we keep showing the last data during background refreshes, so the
  // page never flashes back to skeletons. Purely presentational.
  const everLoaded = useRef(false);
  if (!loading) everLoaded.current = true;
  const firstLoad = loading && !everLoaded.current;

  const [withdrawAmt, setWithdrawAmt] = useState('5');
  const [destination, setDestination] = useState('');
  const [dob, setDob] = useState(profile?.dateOfBirth ?? '');
  const [country, setCountry] = useState(profile?.country ?? '');
  const [exclDays, setExclDays] = useState('30');
  // In-flight guards: disable money buttons while a request is pending so a
  // double-click can't double-submit.
  const [withdrawing, setWithdrawing] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false); // DOB/country save in flight — guard double-submit
  const [excluding, setExcluding] = useState(false); // self-exclude in flight (a safety control — guard double-fire)
  const [txFilter, setTxFilter] = useState<'all' | 'deposit' | 'withdrawal' | 'bet' | 'payout' | 'transfer'>('all');
  const [exporting, setExporting] = useState(false); // GDPR data export in flight
  const [deleting, setDeleting] = useState(false); // GDPR account deletion in flight
  // Fee-free USDT-TRC20 deposit: our receiving address + the player's TxID.
  const [depAddr, setDepAddr] = useState<string | null>(null);
  const [txId, setTxId] = useState('');
  const [submittingTxid, setSubmittingTxid] = useState(false);

  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    void walletApi.depositAddress(token).then((r) => setDepAddr(r.address)).catch(() => {});
  }, []);

  const onSubmitTxid = async () => {
    if (submittingTxid) return;
    const id = txId.trim();
    if (id.length < 60) { useWalletStore.setState({ error: tr('wallet.errTxid') }); return; }
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setSubmittingTxid(true);
    try {
      const r = await walletApi.submitDepositTxid(token, id);
      setTxId('');
      useWalletStore.setState({ notice: tr('wallet.depositCredited'), error: null });
      await refresh();
      return r;
    } catch (e) {
      useWalletStore.setState({ error: e instanceof ApiError ? e.message : tr('wallet.errTxidVerify') });
    } finally {
      setSubmittingTxid(false);
    }
  };

  // Celebrate a balance INCREASE (e.g. a deposit credited) once the initial load has
  // settled, so the 0→balance load on mount never falsely fires confetti.
  const prevBalance = useRef(balanceCents);
  const settled = useRef(false);
  const [gain, setGain] = useState(0);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    const tm = setTimeout(() => { settled.current = true; }, 1200);
    return () => clearTimeout(tm);
  }, []);
  useEffect(() => {
    const prev = prevBalance.current;
    prevBalance.current = balanceCents;
    if (!settled.current || balanceCents <= prev) return;
    setGain(balanceCents - prev);
    setCelebrate(true);
    sound.play('coin'); // money credited → a bright coin chime + a celebratory buzz
    haptics.win();
    const a = setTimeout(() => setCelebrate(false), 2400);
    const b = setTimeout(() => setGain(0), 1600);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [balanceCents]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    setDob(profile?.dateOfBirth ?? '');
    setCountry(profile?.country ?? '');
  }, [profile]);

  const onWithdraw = async () => {
    if (withdrawing) return;
    const cents = parseDollarsToCents(withdrawAmt);
    if (!cents || cents <= 0) {
      useWalletStore.setState({ error: tr('wallet.errAmountGt0') });
      return;
    }
    if (destination.trim().length < 4) {
      useWalletStore.setState({ error: tr('wallet.errDestMin') });
      return;
    }
    if (!(await confirm({
      title: t('wallet.confirmWithdrawT'),
      message: t('wallet.confirmWithdrawM', { amount: dollars(cents), dest: destination.trim() }),
      confirmLabel: t('wallet.requestWithdraw'),
    }))) return;
    setWithdrawing(true);
    try { await withdraw(cents, destination.trim()); } finally { setWithdrawing(false); }
  };

  const onSaveProfile = async () => {
    if (savingProfile) return;
    setSavingProfile(true);
    try { await setProfile(dob, country); } finally { setSavingProfile(false); }
  };

  const onSelfExclude = async () => {
    if (excluding) return;
    const days = Number(exclDays) || 0;
    if (days <= 0) return;
    if (!(await confirm({
      title: t('wallet.confirmExcludeT'),
      message: t('wallet.confirmExcludeM', { days }),
      danger: true,
      confirmLabel: t('wallet.selfExclude'),
    }))) return;
    setExcluding(true);
    try { await selfExclude(days); } finally { setExcluding(false); }
  };

  // GDPR Art.15/20: download everything we hold about you as one JSON file.
  const onExportData = async () => {
    if (exporting) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setExporting(true);
    try {
      const data = await accountApi.exportData(token);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'murlan-data.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      useWalletStore.setState({ error: e instanceof ApiError ? e.message : tr('wallet.exportFailed') });
    } finally {
      setExporting(false);
    }
  };

  // GDPR Art.17: irreversibly delete (anonymize) the account. Double-confirm.
  const onDeleteAccount = async () => {
    if (deleting) return;
    if (!(await confirm({ title: t('wallet.deleteAccountT'), message: t('wallet.deleteAccountM'), danger: true, confirmLabel: t('wallet.deleteAccountNext') }))) return;
    if (!(await confirm({ title: t('wallet.deleteAccountT2'), message: t('wallet.deleteAccountM2'), danger: true, confirmLabel: t('wallet.deleteAccount') }))) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setDeleting(true);
    try {
      await accountApi.deleteAccount(token);
      await useAuthStore.getState().logout(); // unmounts to the auth screen
    } catch (e) {
      useWalletStore.setState({ error: e instanceof ApiError ? e.message : tr('wallet.deleteFailed') });
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Back to lobby */}
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        {t('common.backToLobby')}
      </button>

      {/* Balance hero */}
      <section className="panel-solid p-6 animate-rise text-center relative overflow-hidden">
        <h1 className="font-serif text-xs tracking-[0.4em] text-muted mb-2">{t('wallet.balance')}</h1>
        <div className="flex items-center justify-center gap-3">
          <span
            className="coin-anim shrink-0 rounded-full"
            aria-hidden
            style={{
              width: 34, height: 34,
              background: 'radial-gradient(circle at 35% 30%, #fff3cf, #e8c879 55%, #a9842f)',
              boxShadow: '0 4px 10px -3px rgba(0,0,0,.6), inset 0 1px 2px rgba(255,255,255,.6)',
            }}
          />
          {firstLoad ? (
            <span aria-hidden className="animate-pulse bg-white/10 rounded h-12 w-44" />
          ) : (
            <CountUp valueCents={balanceCents} className="gold-text font-display font-bold text-5xl tracking-wide tabular-nums" />
          )}
        </div>
        {gain > 0 && (
          <span className="float-up absolute left-1/2 -translate-x-1/2 top-9 text-emerald-300 font-display font-bold text-xl pointer-events-none">
            +{dollars(gain)}
          </span>
        )}
      </section>
      {celebrate && <Confetti />}
      {dialog}

      {(error || notice) && (
        <button
          type="button"
          className={`w-full text-left rounded-lg px-3 py-2 text-sm border cursor-pointer ${
            error
              ? 'text-red-300 bg-suit/15 border-suit/40'
              : 'text-emerald-200 bg-emerald-700/15 border-emerald-500/40'
          }`}
          role={error ? 'alert' : 'status'}
          aria-label={t('common.close')}
          onClick={clearMessages}
        >
          {error || notice}
        </button>
      )}

      <RgStatusBanner />

      {/* Fee-free USDT-TRC20 deposit: send to our address, then paste the TxID. */}
      {depAddr && (
        <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.06s' }}>
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('wallet.depositTrc20')}</h2>
          <TronWarning />
          <p className="text-sm text-muted">{t('wallet.depositTrc20Steps')}</p>
          <div>
            <span className="field-label">{t('wallet.yourAddress')}</span>
            <div className="flex items-center gap-2">
              <code className="field flex-1 font-mono text-xs break-all select-all">{depAddr}</code>
              <button onClick={() => void navigator.clipboard?.writeText(depAddr)} className="btn btn-ghost btn-sm shrink-0">{t('common.copy')}</button>
            </div>
          </div>
          {/* Auto-credit is the primary path now (unique per-player address). */}
          <p className="text-sm text-emerald-300 bg-emerald-700/10 border border-emerald-500/30 rounded-lg px-3 py-2">
            ✓ {t('wallet.autoCreditNote')}
          </p>
          {/* Calm, honest "waiting" hint — no fake confirmation counter — plus a
              Tronscan link for the actual receiving address so the player can watch
              the chain themselves. */}
          <div className="rounded-lg border border-white/10 bg-white/[.02] px-3 py-2 space-y-1.5">
            <p className="text-[12px] text-muted leading-snug">⏳ {t('wallet.depositWaitHint')}</p>
            <a
              href={`https://tronscan.org/#/address/${depAddr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] font-medium text-gold-hi underline underline-offset-2 hover:opacity-80"
            >
              {t('wallet.viewOnTronscan')} ↗
            </a>
          </div>
          {/* TxID is now a FALLBACK for when the poller is slow / the page was closed. */}
          <details className="rounded-lg border border-white/10 bg-white/[.02] px-3 py-2">
            <summary className="text-xs text-muted cursor-pointer select-none">{t('wallet.txidFallback')}</summary>
            <label className="block mt-2">
              <span className="field-label">{t('wallet.txidLabel')}</span>
              <input value={txId} onChange={(e) => setTxId(e.target.value)} placeholder={t('wallet.txidPlaceholder')} aria-label={t('wallet.txidLabel')} className="field font-mono" />
            </label>
            <button onClick={() => void onSubmitTxid()} disabled={submittingTxid} className="btn btn-outline btn-sm mt-2 w-full sm:w-auto">
              {submittingTxid ? t('wallet.verifying') : t('wallet.confirmDeposit')}
            </button>
          </details>
        </section>
      )}

      {/* Withdraw */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.12s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('wallet.withdraw')}</h2>
        {/* KYC removed (owner decision): no identity verification is required to
            withdraw. Large/uncapped requests still go to MANUAL operator review. */}
        <TronWarning />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <label className="block">
            <span className="field-label">{t('wallet.amountUsd')}</span>
            <input type="number" min="1" step="1" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)}
              className="field" />
          </label>
          <label className="block sm:col-span-2">
            <span className="field-label">{t('wallet.addressDest')}</span>
            <div className="relative">
              <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={t('wallet.addressPlaceholder')}
                className="field pr-8" />
              {destination.trim().length > 0 && (
                <span
                  className={`absolute right-2.5 top-1/2 -translate-y-1/2 text-sm font-bold ${isLikelyTron(destination) ? 'text-emerald-400' : 'text-red-400'}`}
                  aria-label={isLikelyTron(destination) ? t('wallet.addrValid') : t('wallet.addrInvalid')}
                >{isLikelyTron(destination) ? '✓' : '✗'}</span>
              )}
            </div>
          </label>
        </div>
        {(parseDollarsToCents(withdrawAmt) ?? 0) > 0 && (
          <p className="text-[12px] font-medium text-emerald-300">
            {t('wallet.youReceive', { amount: dollars(Math.max(0, (parseDollarsToCents(withdrawAmt) ?? 0) - WITHDRAW_FEE_CENTS)) })}
          </p>
        )}
        {/* Honest payout timing so the player knows what to expect. */}
        <p className="text-[12px] text-muted">⏱ {t('wallet.withdrawTimeEstimate')}</p>
        <button onClick={() => void onWithdraw()} disabled={withdrawing} className="btn btn-ghost">{withdrawing ? t('wallet.sending') : t('wallet.requestWithdraw')}</button>
      </section>

      {/* Verification / responsible gaming */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.16s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('wallet.verifyRG')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <label className="block">
            <span className="field-label">{t('wallet.dob')}</span>
            <input type="date" value={dob} onChange={(e) => setDob(e.target.value)}
              className="field" />
          </label>
          <label className="block">
            <span className="field-label">{t('wallet.country')}</span>
            <input maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} placeholder="AL"
              className="field uppercase" />
          </label>
          <button onClick={() => void onSaveProfile()} disabled={savingProfile} className="btn btn-gold">{savingProfile ? t('wallet.sending') : t('common.save')}</button>
        </div>
        <div className="flex flex-wrap gap-3 items-end pt-1">
          <label className="block">
            <span className="field-label">{t('wallet.selfExcludeDays')}</span>
            <input type="number" min="1" value={exclDays} onChange={(e) => setExclDays(e.target.value)}
              className="field w-28" />
          </label>
          <button onClick={() => void onSelfExclude()} disabled={excluding} className="btn btn-danger w-full sm:w-auto">
            {excluding ? t('wallet.sending') : t('wallet.selfExclude')}
          </button>
        </div>
        {profile?.selfExcludedUntil && profile.selfExcludedUntil > Date.now() && (
          <p className="text-xs text-red-300">{t('wallet.selfExcludedUntil', { date: new Date(profile.selfExcludedUntil).toLocaleDateString() })}</p>
        )}

        <RgLimitsControls />

        {/* GDPR data export (Art.15/20): the player downloads all their data. */}
        <div className="pt-2 mt-1 border-t border-white/10 space-y-2">
          <div className="field-label">{t('wallet.yourData')}</div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void onExportData()} disabled={exporting} className="btn btn-ghost btn-sm">
              {exporting ? t('wallet.exporting') : t('wallet.exportData')}
            </button>
            <button onClick={() => void onDeleteAccount()} disabled={deleting} className="btn btn-danger btn-sm">
              {deleting ? t('wallet.sending') : t('wallet.deleteAccount')}
            </button>
          </div>
          <p className="text-[11px] text-muted/70">{t('wallet.exportHint')}</p>
        </div>
      </section>

      {/* History */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.2s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('wallet.txHistory')}</h2>
        {/* Filter chips: narrow the ledger to one kind. */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {(['all', 'deposit', 'withdrawal', 'bet', 'payout', 'transfer'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTxFilter(f)}
              className={`text-xs rounded-full px-2.5 py-1 border ${txFilter === f ? 'border-gold bg-gold/[.12] text-gold-hi' : 'border-white/10 text-muted'}`}
            >
              {t(`wallet.txf.${f}`)}
            </button>
          ))}
        </div>
        {firstLoad && transactions.length === 0 ? (
          <ul className="space-y-2.5" aria-hidden>
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-white/[.02]">
                <span className="animate-pulse bg-white/10 rounded h-5 w-16 shrink-0" />
                <span className="flex-1 min-w-0 space-y-1.5">
                  <span className="block animate-pulse bg-white/10 rounded h-3 w-3/4" />
                  <span className="block animate-pulse bg-white/5 rounded h-2.5 w-1/3" />
                </span>
                <span className="ml-auto animate-pulse bg-white/10 rounded h-5 w-14" />
              </li>
            ))}
          </ul>
        ) : (() => {
          const shown = transactions.filter((x) => txFilter === 'all'
            || (txFilter === 'transfer' ? x.type === 'transfer_in' || x.type === 'transfer_out' : x.type === txFilter)).slice(0, 30);
          if (shown.length === 0) {
            return (
              <div className="text-center py-8">
                <div className="text-4xl mb-2 opacity-60">🧾</div>
                <p className="text-sm text-muted">{t('wallet.noTx')}</p>
              </div>
            );
          }
          return (
          <ul className="space-y-2.5">
            {shown.map((tx) => {
              // A bet/payout row links to its match replay (the provably-fair recap).
              const linkable = !!tx.matchId && (tx.type === 'bet' || tx.type === 'payout');
              const Row = linkable ? 'button' : 'div';
              return (
              <Row
                key={tx.id}
                {...(linkable ? { onClick: () => useUiStore.getState().openReplay(tx.matchId!) } : {})}
                className={`w-full text-left flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] ${linkable ? 'hover:border-gold/40' : ''}`}
              >
                <span className="tag tag-open">{txLabel(tx.type)}</span>
                <span className="flex-1 min-w-0">
                  {tx.reason && <span className="block text-xs text-muted truncate">{tx.reason}</span>}
                  <span className="block text-[11px] text-muted/70">{new Date(tx.createdAt).toLocaleString()}{linkable ? ` · ${t('wallet.viewMatch')}` : ''}</span>
                </span>
                <span className={`ml-auto font-display font-semibold tracking-wide ${tx.amountCents >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {tx.amountCents >= 0 ? '+' : '−'}{dollars(Math.abs(tx.amountCents))}
                </span>
              </Row>
              );
            })}
          </ul>
          );
        })()}
      </section>

      {firstLoad && withdrawals.length === 0 ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.24s' }}>
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('wallet.withdrawalsTitle')}</h2>
          <ul className="space-y-2.5" aria-hidden>
            {Array.from({ length: 2 }).map((_, i) => (
              <li key={i} className="rounded-xl px-4 py-3 border border-white/10 bg-white/[.02]">
                <div className="flex items-center gap-3">
                  <span className="animate-pulse bg-white/10 rounded h-5 w-16" />
                  <span className="flex-1 animate-pulse bg-white/5 rounded h-3.5 w-1/2" />
                  <span className="ml-auto animate-pulse bg-white/10 rounded h-5 w-20" />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : withdrawals.length > 0 && (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.24s' }}>
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('wallet.withdrawalsTitle')}</h2>
          <ul className="space-y-2.5">
            {withdrawals.map((w) => (
              <li
                key={w.id}
                className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]"
              >
                <div className="flex items-center gap-3">
                  <span className="font-display font-semibold tracking-wide text-txt">{dollars(w.amountCents)}</span>
                  <span className="text-sm text-muted flex-1 truncate">→ {w.destination}</span>
                  <span className={`tag ml-auto ${w.status === 'rejected' ? 'tag-live text-red-300' : 'tag-live'}`}>{t(w.status === 'completed' ? 'wallet.wstatusCompleted' : w.status === 'rejected' ? 'wallet.wstatusRejected' : 'wallet.wstatusPending')}</span>
                </div>
                {w.status === 'rejected' && w.failureReason && (
                  <p className="text-[12px] text-red-300/90 mt-1.5">{t('wallet.rejectedReason')} {w.failureReason}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Responsible-gaming: warn when the player is at/over 80% of a daily limit they set.
 *  Self-contained — fetches its own status; renders nothing if no limit is near. */
function RgStatusBanner() {
  const t = useT();
  const [st, setSt] = useState<{ dailyDepositLimitCents: number | null; dailyLossLimitCents: number | null; depositUsedTodayCents: number; lossTodayCents: number } | null>(null);
  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    void accountApi.rgStatus(token).then((r) => setSt(r.status)).catch(() => {});
  }, []);
  if (!st) return null;
  const warnings: string[] = [];
  if (st.dailyDepositLimitCents && st.depositUsedTodayCents / st.dailyDepositLimitCents >= 0.8) {
    warnings.push(t('wallet.rgNearDeposit', { used: dollars(st.depositUsedTodayCents), limit: dollars(st.dailyDepositLimitCents) }));
  }
  if (st.dailyLossLimitCents && st.lossTodayCents / st.dailyLossLimitCents >= 0.8) {
    warnings.push(t('wallet.rgNearLoss', { used: dollars(st.lossTodayCents), limit: dollars(st.dailyLossLimitCents) }));
  }
  if (warnings.length === 0) return null;
  return (
    <section role="status" className="panel p-3 border border-amber-500/40 bg-amber-700/10 animate-rise">
      <div className="text-sm text-amber-200 font-display font-semibold mb-1">⚠️ {t('wallet.rgNearTitle')}</div>
      {warnings.map((w, i) => <p key={i} className="text-xs text-amber-100/90">{w}</p>)}
    </section>
  );
}

/** Self-service responsible-gaming daily caps (deposit + loss). Fetches/saves via
 *  the account API; empty/0 clears a limit. */
function RgLimitsControls() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const [limits, setLimitsState] = useState<RgLimits | null>(null);
  const [dep, setDep] = useState('');
  const [loss, setLoss] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    void accountApi.getLimits(token).then(({ limits }) => {
      setLimitsState(limits);
      setDep(limits.dailyDepositLimitCents != null ? String(limits.dailyDepositLimitCents / 100) : '');
      setLoss(limits.dailyLossLimitCents != null ? String(limits.dailyLossLimitCents / 100) : '');
    }).catch(() => undefined);
  }, []);

  const toCents = (s: string): number | null => {
    const c = Math.round(parseFloat(s || '0') * 100);
    return Number.isFinite(c) && c > 0 ? c : null;
  };
  const save = async (patch: Partial<RgLimits>): Promise<boolean> => {
    const token = useAuthStore.getState().accessToken;
    if (!token || busy) return false;
    setBusy(true); setErr(null);
    try { setLimitsState((await accountApi.setLimits(token, patch)).limits); return true; }
    catch (e) { setErr(e instanceof ApiError ? e.message : t('err.limitSaveFailed')); return false; }
    finally { setBusy(false); }
  };
  // RG limits are a safety control: confirm removal, and clear the field ONLY if the
  // save actually succeeded (so a failed remove can't look like it worked).
  const removeLimit = async (which: 'deposit' | 'loss') => {
    if (!(await confirm({ title: t('wallet.removeLimitT'), message: t('wallet.removeLimitM'), confirmLabel: t('common.remove') }))) return;
    const ok = await save(which === 'deposit' ? { dailyDepositLimitCents: null } : { dailyLossLimitCents: null });
    if (ok) { if (which === 'deposit') setDep(''); else setLoss(''); }
  };

  return (
    <div className="pt-2 mt-1 border-t border-white/10 space-y-2.5">
      <div className="field-label">{t('wallet.dailyLimits')}</div>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="block">
          <span className="field-label">{t('wallet.depositMaxDay')}</span>
          <input type="number" min="0" step="1" value={dep} onChange={(e) => setDep(e.target.value)} placeholder={t('wallet.noLimit')} className="field w-32" />
        </label>
        <button disabled={busy} onClick={() => void save({ dailyDepositLimitCents: toCents(dep) })} className="btn btn-gold">{t('common.save')}</button>
        <button disabled={busy} onClick={() => void removeLimit('deposit')} className="btn btn-ghost">{t('common.remove')}</button>
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="block">
          <span className="field-label">{t('wallet.lossMaxDay')}</span>
          <input type="number" min="0" step="1" value={loss} onChange={(e) => setLoss(e.target.value)} placeholder={t('wallet.noLimit')} className="field w-32" />
        </label>
        <button disabled={busy} onClick={() => void save({ dailyLossLimitCents: toCents(loss) })} className="btn btn-gold">{t('common.save')}</button>
        <button disabled={busy} onClick={() => void removeLimit('loss')} className="btn btn-ghost">{t('common.remove')}</button>
      </div>
      {limits && (
        <p className="text-[11px] text-muted">
          {t('wallet.limitsNow', {
            dep: limits.dailyDepositLimitCents != null ? dollars(limits.dailyDepositLimitCents) : t('wallet.noLimit'),
            loss: limits.dailyLossLimitCents != null ? dollars(limits.dailyLossLimitCents) : t('wallet.noLimit'),
          })}
        </p>
      )}
      {err && <p className="text-[11px] text-red-300">{err}</p>}
      {dialog}
    </div>
  );
}
