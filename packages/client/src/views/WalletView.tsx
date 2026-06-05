import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/walletStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { accountApi, type RgLimits } from '../lib/api.ts';
import { dollars, parseDollarsToCents, txLabel } from '../lib/money.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

/** For errors set OUTSIDE React render (store.setState) — translate with the live lang. */
const tr = (key: string) => translate(key, useLangStore.getState().lang);

export function WalletView() {
  const {
    balanceCents, transactions, withdrawals, profile, lastIntent, error, notice,
    refresh, deposit, withdraw, setProfile, selfExclude, clearMessages,
  } = useWalletStore();
  const setView = useUiStore((s) => s.setView);
  const t = useT();

  const [depositAmt, setDepositAmt] = useState('10');
  const [withdrawAmt, setWithdrawAmt] = useState('5');
  const [destination, setDestination] = useState('');
  const [dob, setDob] = useState(profile?.dateOfBirth ?? '');
  const [country, setCountry] = useState(profile?.country ?? '');
  const [exclDays, setExclDays] = useState('30');
  // In-flight guards: disable money buttons while a request is pending so a
  // double-click can't fire two deposits / split one withdrawal into duplicates.
  const [depositing, setDepositing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    setDob(profile?.dateOfBirth ?? '');
    setCountry(profile?.country ?? '');
  }, [profile]);

  const onDeposit = async () => {
    if (depositing) return;
    const cents = parseDollarsToCents(depositAmt);
    if (!cents || cents <= 0) {
      useWalletStore.setState({ error: tr('wallet.errAmountGt0') });
      return;
    }
    setDepositing(true);
    try { await deposit(cents); } finally { setDepositing(false); }
  };
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
    setWithdrawing(true);
    try { await withdraw(cents, destination.trim()); } finally { setWithdrawing(false); }
  };

  return (
    <div className="space-y-5">
      {/* Back to lobby */}
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        {t('common.backToLobby')}
      </button>

      {/* Balance */}
      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('wallet.section')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('wallet.balance')}</h1>
        </div>
        <span className="chip text-lg">
          <span className="coin" />
          {dollars(balanceCents)}
        </span>
      </section>

      {(error || notice) && (
        <div
          className={`rounded-lg px-3 py-2 text-sm border cursor-pointer ${
            error
              ? 'text-red-300 bg-suit/15 border-suit/40'
              : 'text-emerald-200 bg-emerald-700/15 border-emerald-500/40'
          }`}
          role="status"
          onClick={clearMessages}
        >
          {error || notice}
        </div>
      )}

      {/* Deposit */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.08s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('wallet.deposit')}</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex-1">
            <span className="field-label">{t('wallet.amountUsd')}</span>
            <input type="number" min="1" step="1" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)}
              className="field" />
          </label>
          <button onClick={() => void onDeposit()} disabled={depositing} className="btn btn-gold w-full sm:w-auto">{depositing ? t('wallet.sending') : t('wallet.crypto')}</button>
          <button disabled className="btn btn-ghost w-full sm:w-auto" title={t('wallet.soon')}>PayPal</button>
        </div>
        {lastIntent && (
          <div className="panel-solid p-3 text-xs break-all">
            <div className="text-muted">{t('wallet.sendToAddress', { amount: dollars(lastIntent.amountCents) })}</div>
            <div className="font-mono text-emerald-300 mt-0.5">{lastIntent.payAddress}</div>
            <div className="text-muted/70 mt-1">{t('wallet.testModeNote')}</div>
          </div>
        )}
      </section>

      {/* Withdraw */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.12s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('wallet.withdraw')}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <label className="block">
            <span className="field-label">{t('wallet.amountUsd')}</span>
            <input type="number" min="1" step="1" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)}
              className="field" />
          </label>
          <label className="block sm:col-span-2">
            <span className="field-label">{t('wallet.addressDest')}</span>
            <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={t('wallet.addressPlaceholder')}
              className="field" />
          </label>
        </div>
        <button onClick={() => void onWithdraw()} disabled={withdrawing} className="btn btn-ghost">{withdrawing ? t('wallet.sending') : t('wallet.requestWithdraw')}</button>
      </section>

      {/* Verification / responsible gaming */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.16s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('wallet.verifyRG')}</h2>
        <p className="text-xs text-muted">{t('wallet.kycStatus')} <span className="text-txt">{profile?.kycStatus ?? '—'}</span></p>
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
          <button onClick={() => void setProfile(dob, country)} className="btn btn-gold">{t('common.save')}</button>
        </div>
        <div className="flex flex-wrap gap-3 items-end pt-1">
          <label className="block">
            <span className="field-label">{t('wallet.selfExcludeDays')}</span>
            <input type="number" min="1" value={exclDays} onChange={(e) => setExclDays(e.target.value)}
              className="field w-28" />
          </label>
          <button onClick={() => void selfExclude(Number(exclDays) || 0)} className="btn btn-danger w-full sm:w-auto">
            {t('wallet.selfExclude')}
          </button>
        </div>
        {profile?.selfExcludedUntil && profile.selfExcludedUntil > Date.now() && (
          <p className="text-xs text-red-300">{t('wallet.selfExcludedUntil', { date: new Date(profile.selfExcludedUntil).toLocaleDateString() })}</p>
        )}

        <RgLimitsControls />
      </section>

      {/* History */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.2s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('wallet.txHistory')}</h2>
        {transactions.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-2 opacity-60">🧾</div>
            <p className="text-sm text-muted">{t('wallet.noTx')}</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {transactions.slice(0, 30).map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]"
              >
                <span className="tag tag-open">{txLabel(t.type)}</span>
                {t.reason && <span className="text-xs text-muted flex-1 truncate">{t.reason}</span>}
                <span className={`ml-auto font-display font-semibold tracking-wide ${t.amountCents >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                  {t.amountCents >= 0 ? '+' : '−'}{dollars(Math.abs(t.amountCents))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {withdrawals.length > 0 && (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.24s' }}>
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('wallet.withdrawalsTitle')}</h2>
          <ul className="space-y-2.5">
            {withdrawals.map((w) => (
              <li
                key={w.id}
                className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]"
              >
                <span className="font-display font-semibold tracking-wide text-txt">{dollars(w.amountCents)}</span>
                <span className="text-sm text-muted flex-1 truncate">→ {w.destination}</span>
                <span className="tag tag-live ml-auto">{w.status}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Self-service responsible-gaming daily caps (deposit + loss). Fetches/saves via
 *  the account API; empty/0 clears a limit. */
function RgLimitsControls() {
  const t = useT();
  const [limits, setLimitsState] = useState<RgLimits | null>(null);
  const [dep, setDep] = useState('');
  const [loss, setLoss] = useState('');
  const [busy, setBusy] = useState(false);

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
  const save = async (patch: Partial<RgLimits>) => {
    const token = useAuthStore.getState().accessToken;
    if (!token || busy) return;
    setBusy(true);
    try { setLimitsState((await accountApi.setLimits(token, patch)).limits); } catch { /* surfaced elsewhere */ } finally { setBusy(false); }
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
        <button disabled={busy} onClick={() => { setDep(''); void save({ dailyDepositLimitCents: null }); }} className="btn btn-ghost">{t('common.remove')}</button>
      </div>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="block">
          <span className="field-label">{t('wallet.lossMaxDay')}</span>
          <input type="number" min="0" step="1" value={loss} onChange={(e) => setLoss(e.target.value)} placeholder={t('wallet.noLimit')} className="field w-32" />
        </label>
        <button disabled={busy} onClick={() => void save({ dailyLossLimitCents: toCents(loss) })} className="btn btn-gold">{t('common.save')}</button>
        <button disabled={busy} onClick={() => { setLoss(''); void save({ dailyLossLimitCents: null }); }} className="btn btn-ghost">{t('common.remove')}</button>
      </div>
      {limits && (
        <p className="text-[11px] text-muted">
          {t('wallet.limitsNow', {
            dep: limits.dailyDepositLimitCents != null ? dollars(limits.dailyDepositLimitCents) : t('wallet.noLimit'),
            loss: limits.dailyLossLimitCents != null ? dollars(limits.dailyLossLimitCents) : t('wallet.noLimit'),
          })}
        </p>
      )}
    </div>
  );
}
