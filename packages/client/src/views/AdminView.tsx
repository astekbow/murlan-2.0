import { useEffect, useState } from 'react';
import { useAdminStore } from '../store/adminStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { dollars } from '../lib/money.ts';
import { adminApi } from '../lib/api.ts';
import type { AdminUser, SupportTicket, AdminActionRecord, Transaction, AdminAccountState } from '../lib/api.ts';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { useT } from '../lib/i18n.ts';

function UserRow({ user }: { user: AdminUser }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { adjust, setKyc, setRole } = useAdminStore();
  const [delta, setDelta] = useState('10');
  const [reason, setReason] = useState('manual');

  const onAdjust = async (sign: 1 | -1) => {
    const cents = Math.round((parseFloat(delta) || 0) * 100) * sign;
    if (cents === 0) return;
    if (!(await confirm({
      title: sign > 0 ? t('admin.credit') : t('admin.debit'),
      message: t('admin.confirmAdjustM', { amount: dollars(Math.abs(cents)), user: user.username }),
      danger: sign < 0,
    }))) return;
    void adjust(user.id, cents, reason || 'manual');
  };

  const onToggleRole = async () => {
    const makeAdmin = user.role !== 'admin';
    if (!(await confirm({
      title: makeAdmin ? t('admin.makeAdmin') : t('admin.removeAdmin'),
      message: t('admin.confirmRoleM', { user: user.username }),
      danger: !makeAdmin,
    }))) return;
    void setRole(user.id, makeAdmin ? 'admin' : 'user');
  };

  const [txns, setTxns] = useState<Transaction[] | null>(null);
  const applyState = async (state: AdminAccountState) => {
    if (!(await confirm({ title: t('admin.accountState'), message: t('admin.confirmStateM', { state, user: user.username }), danger: state === 'banned' || state === 'suspended' }))) return;
    const token = useAuthStore.getState().accessToken;
    if (token) { try { await adminApi.setAccountState(token, user.id, state); } catch { /* surfaced via toast elsewhere */ } }
  };
  const loadTxns = async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try { const r = await adminApi.transactions(token, user.id); setTxns(r.transactions); } catch { setTxns([]); }
  };

  return (
    <li className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm">
          <span className="font-display font-semibold tracking-wide text-txt">{user.username}</span>
          <span className="text-muted"> · {user.email} · {user.role}</span>
        </div>
        <span className="chip">
          <span className="coin" />
          {dollars(user.balanceCents)}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="field-label">KYC:</span>
        <div className="seg">
          {(['none', 'pending', 'verified'] as const).map((s) => (
            <button
              key={s}
              onClick={() => void setKyc(user.id, s)}
              className={`seg-tab ${user.kycStatus === s ? 'active' : ''}`}
            >
              {s}
            </button>
          ))}
        </div>
        <button
          onClick={() => void onToggleRole()}
          className={`btn ml-auto ${user.role === 'admin' ? 'btn-danger' : 'btn-ghost'}`}
        >
          {user.role === 'admin' ? t('admin.removeAdmin') : t('admin.makeAdmin')}
        </button>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <label className="block">
          <span className="field-label">USD</span>
          <input
            type="number"
            min="0"
            max="50000"
            step="1"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            className="field w-24"
            title="USD"
          />
        </label>
        <label className="block flex-1 min-w-[140px]">
          <span className="field-label">{t('admin.reason')}</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin.reasonPlaceholder')}
            className="field"
          />
        </label>
        <button onClick={() => void onAdjust(1)} className="btn btn-green">{t('admin.credit')}</button>
        <button onClick={() => void onAdjust(-1)} className="btn btn-danger">{t('admin.debit')}</button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="field-label">{t('admin.accountState')}:</span>
        {(['active', 'frozen', 'suspended', 'banned'] as const).map((s) => (
          <button key={s} onClick={() => void applyState(s)} className="btn btn-ghost btn-xs">{s}</button>
        ))}
        <button onClick={() => { if (txns) setTxns(null); else void loadTxns(); }} className="btn btn-ghost btn-xs ml-auto">
          {txns ? t('admin.hideTx') : t('admin.viewTx')}
        </button>
      </div>
      {txns && (
        <ul className="space-y-1 max-h-[30vh] overflow-y-auto -mr-1 pr-1">
          {txns.length === 0 ? (
            <li className="text-xs text-muted italic">{t('admin.noTx')}</li>
          ) : txns.map((tx) => (
            <li key={tx.id} className="text-xs flex items-center gap-2 rounded px-2 py-1 border border-white/10 bg-white/[.02]">
              <span className="font-mono text-gold-hi/80 shrink-0 w-24 truncate">{tx.type}</span>
              <b className="text-txt shrink-0">{dollars(tx.amountCents)}</b>
              <span className="text-muted truncate flex-1">{tx.reason ?? tx.matchId ?? ''}</span>
              <span className="text-muted/60 shrink-0">{new Date(tx.createdAt).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </li>
  );
}

export function AdminView() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { users, withdrawals, matches, revenueCents, error, notice, refresh, approve, reject } = useAdminStore();
  const setView = useUiStore((s) => s.setView);
  const [userQuery, setUserQuery] = useState('');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [auditLog, setAuditLog] = useState<AdminActionRecord[]>([]);

  const loadDepth = () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    void adminApi.support(token).then((r) => setTickets(r.tickets)).catch(() => {});
    void adminApi.audit(token).then((r) => setAuditLog(r.actions)).catch(() => {});
  };

  useEffect(() => {
    void refresh();
    loadDepth();
  }, [refresh]);

  const resolveTicket = async (id: string) => {
    if (!(await confirm({ title: t('admin.resolveTicket'), message: t('admin.confirmResolveM') }))) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    await adminApi.resolveTicket(token, id, 'resolved');
    loadDepth();
  };

  const openTickets = tickets.filter((tk) => tk.status === 'open');

  const q = userQuery.trim().toLowerCase();
  const shownUsers = q
    ? users.filter((u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    : users;

  return (
    <div className="space-y-5">
      <h1 className="sr-only">{t('admin.panelTitle')}</h1>
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>
        <button onClick={() => void refresh()} className="btn btn-ghost">{t('common.refresh')}</button>
      </div>
      {dialog}

      {/* Revenue: the accumulated house rake (your 10% cut). */}
      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('admin.revenueEyebrow')}</div>
          <h2 className="gold-text font-display font-bold text-2xl tracking-wide leading-none">{t('admin.revenueTitle')}</h2>
          <p className="text-[11px] text-muted/70 mt-1">{t('admin.revenueNote')}</p>
        </div>
        <div className="text-right">
          <div className="font-display font-semibold tracking-wide text-gold-hi text-3xl leading-none">
            {revenueCents == null ? '—' : dollars(revenueCents)}
          </div>
        </div>
      </section>

      {(error || notice) && (
        <div
          className={`text-sm rounded-lg px-3 py-2 ${
            error
              ? 'text-red-300 bg-suit/15 border border-suit/40'
              : 'text-emerald-200 bg-emerald-500/10 border border-emerald-500/40'
          }`}
          role="status"
        >
          {error || notice}
        </div>
      )}

      {/* Withdrawals */}
      <section className="panel p-5 animate-rise">
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('admin.pendingWithdrawals')}</h2>
        {withdrawals.length === 0 ? (
          <p className="text-sm text-muted italic">{t('admin.noPendingWithdrawals')}</p>
        ) : (
          <ul className="space-y-2.5">
            {withdrawals.map((w) => (
              <li
                key={w.id}
                className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]"
              >
                <span className="text-sm">
                  <b className="text-txt">{dollars(w.amountCents)}</b>
                  <span className="text-muted"> → {w.destination}</span>
                </span>
                <span className="flex gap-2">
                  <button onClick={async () => { if (await confirm({ title: t('admin.approve'), message: t('admin.confirmApproveM', { amount: dollars(w.amountCents), dest: w.destination }) })) void approve(w.id); }} className="btn btn-green">{t('admin.approve')}</button>
                  <button onClick={async () => { if (await confirm({ title: t('admin.reject'), message: t('admin.confirmRejectM', { amount: dollars(w.amountCents) }), danger: true })) void reject(w.id); }} className="btn btn-danger">{t('admin.reject')}</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Active matches */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('admin.activeMatches')}</h2>
        {matches.length === 0 ? (
          <p className="text-sm text-muted italic">{t('admin.noActiveMatches')}</p>
        ) : (
          <ul className="space-y-2.5">
            {matches.map((m) => (
              <li
                key={m.roomId}
                className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] text-sm"
              >
                <span className="font-display font-semibold tracking-wide text-txt">{m.type}</span>
                <span className="text-muted"> · {dollars(m.stakeCents)} · {t('admin.target')} {m.target} · {m.players.map((p) => p.username ?? `?${p.seat}`).join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Support tickets — triage disputes / payment / account issues. */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.1s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3 flex items-center gap-2">
          {t('admin.support')}
          {openTickets.length > 0 && <span className="tag tag-live">{openTickets.length}</span>}
        </h2>
        {tickets.length === 0 ? (
          <p className="text-sm text-muted italic">{t('admin.noTickets')}</p>
        ) : (
          <ul className="space-y-2.5">
            {tickets.slice(0, 30).map((tk) => (
              <li key={tk.id} className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-display font-semibold tracking-wide text-txt text-sm">{tk.subject}</span>
                  <span className={`tag ${tk.status === 'open' ? 'tag-live' : 'tag-open'}`}>{tk.status}</span>
                </div>
                <p className="text-[11px] text-muted mt-1">{tk.category}{tk.matchId ? ` · ${tk.matchId}` : ''} · {new Date(tk.createdAt).toLocaleDateString()}</p>
                <p className="text-sm text-txt mt-1.5 break-words">{tk.message}</p>
                {tk.adminNote && <p className="text-xs text-gold-hi/80 mt-1">↳ {tk.adminNote}</p>}
                {tk.status === 'open' && (
                  <button onClick={() => void resolveTicket(tk.id)} className="btn btn-gold btn-sm mt-2">{t('admin.resolveTicket')}</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Audit log — immutable who-did-what (compliance). */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('admin.auditLog')}</h2>
        {auditLog.length === 0 ? (
          <p className="text-sm text-muted italic">{t('admin.noAudit')}</p>
        ) : (
          <ul className="space-y-1.5 max-h-[44vh] overflow-y-auto -mr-1 pr-1">
            {auditLog.map((a) => (
              <li key={a.id} className="text-xs flex items-center gap-2 rounded-lg px-3 py-2 border border-white/10 bg-white/[.02]">
                <span className="font-mono text-gold-hi/80 shrink-0">{a.action}</span>
                <span className="text-muted truncate flex-1">{a.detail ?? ''}{a.amountCents != null ? ` (${dollars(a.amountCents)})` : ''}</span>
                <span className="text-muted/60 shrink-0 whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Users */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.16s' }}>
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('admin.users', { n: users.length })}</h2>
          <input
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            placeholder={t('admin.searchUsers')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="field max-w-[220px]"
          />
        </div>
        <ul className="space-y-2.5">
          {shownUsers.map((u) => <UserRow key={u.id} user={u} />)}
        </ul>
      </section>
    </div>
  );
}
