import { useEffect, useState } from 'react';
import { useAdminStore } from '../store/adminStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { dollars } from '../lib/money.ts';
import { adminApi } from '../lib/api.ts';
import type { AdminUser, SupportTicket, AdminActionRecord, Transaction, AdminAccountState, AdminChatReport } from '../lib/api.ts';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { useT } from '../lib/i18n.ts';

// The grantable admin scopes (must mirror ADMIN_PERMISSIONS on the server). An
// admin with NO scopes is a full admin; assigning any scope restricts them.
const ADMIN_PERMS = ['adjust_balance', 'approve_withdrawals', 'manage_accounts', 'manage_admins', 'moderate_chat', 'void_matches', 'view_revenue'] as const;

function UserRow({ user }: { user: AdminUser }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { adjust, setKyc, setRole } = useAdminStore();
  const [delta, setDelta] = useState('10');
  const [reason, setReason] = useState('manual');
  const [perms, setPerms] = useState<string[]>(user.permissions ?? []);

  // Toggle a single scope for this admin, persisting immediately (optimistic; a
  // failure reverts). Empty list = full admin, so clearing all = restore full power.
  const togglePerm = async (p: string) => {
    const prev = perms;
    const next = prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p];
    setPerms(next);
    const token = useAuthStore.getState().accessToken;
    if (token) { try { await adminApi.setPermissions(token, user.id, next); } catch { setPerms(prev); } }
  };

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

  // Chat moderation: global mute (default 24h) / unmute. Confirmed; audited server-side.
  const mute24h = async () => {
    if (!(await confirm({ title: t('admin.mute'), message: t('admin.confirmMuteM', { user: user.username }), danger: true }))) return;
    const token = useAuthStore.getState().accessToken;
    if (token) { try { await adminApi.muteUser(token, user.id, 24 * 60 * 60 * 1000); } catch { /* surfaced via toast elsewhere */ } }
  };
  const unmute = async () => {
    const token = useAuthStore.getState().accessToken;
    if (token) { try { await adminApi.unmuteUser(token, user.id); } catch { /* surfaced via toast elsewhere */ } }
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
        <span className="w-px h-4 bg-white/15 mx-1" aria-hidden />
        <button onClick={() => void mute24h()} className="btn btn-ghost btn-xs">{t('admin.mute')}</button>
        <button onClick={() => void unmute()} className="btn btn-ghost btn-xs">{t('admin.unmute')}</button>
        <button onClick={() => { if (txns) setTxns(null); else void loadTxns(); }} className="btn btn-ghost btn-xs ml-auto">
          {txns ? t('admin.hideTx') : t('admin.viewTx')}
        </button>
      </div>

      {/* Granular admin scopes (RBAC) — only meaningful for admins. No scope
          selected = full admin; selecting any restricts this admin to those. */}
      {user.role === 'admin' && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="field-label">{t('admin.permsLabel')}:</span>
          {ADMIN_PERMS.map((p) => {
            const on = perms.includes(p);
            return (
              <button key={p} onClick={() => void togglePerm(p)} aria-pressed={on} className={`btn btn-xs ${on ? 'btn-gold' : 'btn-ghost'}`} title={t(`admin.perm.${p}`)}>
                {t(`admin.perm.${p}`)}
              </button>
            );
          })}
          <span className="text-[11px] text-muted/70">{perms.length === 0 ? t('admin.permsFull') : t('admin.permsScoped', { n: perms.length })}</span>
        </div>
      )}
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
  const [reports, setReports] = useState<AdminChatReport[]>([]);
  const [kycFilter, setKycFilter] = useState<'all' | 'none' | 'pending' | 'verified'>('all');
  const [sortBy, setSortBy] = useState<'balance' | 'name'>('balance');

  const loadDepth = () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    void adminApi.support(token).then((r) => setTickets(r.tickets)).catch(() => {});
    void adminApi.audit(token).then((r) => setAuditLog(r.actions)).catch(() => {});
    void adminApi.chatReports(token).then((r) => setReports(r.reports)).catch(() => {});
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
  const filteredUsers = users
    .filter((u) => !q || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .filter((u) => kycFilter === 'all' || u.kycStatus === kycFilter);
  const shownUsers = [...filteredUsers].sort((a, b) =>
    sortBy === 'balance' ? b.balanceCents - a.balanceCents : a.username.localeCompare(b.username),
  );
  const USER_CAP = 60; // client-side cap; server-side pagination needed before large scale

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
                <span className="text-sm min-w-0">
                  <b className="text-txt">{dollars(w.amountCents)}</b>
                  <span className="text-muted"> → <span className="break-all">{w.destination}</span></span>
                  <span className="block text-[11px] text-muted/80">
                    {w.username ?? '?'}{w.kycStatus ? ` · KYC ${w.kycStatus}` : ''} · {new Date(w.createdAt).toLocaleString()}
                  </span>
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

      {/* Chat moderation — reported-message queue (read-only triage). Mute/unmute
          live on each user row, since a mute is keyed by user id. */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.11s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3 flex items-center gap-2">
          {t('admin.moderation')}
          {reports.filter((r) => !r.reviewed).length > 0 && <span className="tag tag-live">{reports.filter((r) => !r.reviewed).length}</span>}
        </h2>
        {reports.length === 0 ? (
          <p className="text-sm text-muted italic">{t('admin.noReports')}</p>
        ) : (
          <ul className="space-y-2.5 max-h-[44vh] overflow-y-auto -mr-1 pr-1">
            {reports.slice(0, 50).map((r) => (
              <li key={r.id} className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-display font-semibold tracking-wide text-txt text-sm break-words">{r.reason || t('admin.reportNoReason')}</span>
                  <span className={`tag ${r.reviewed ? 'tag-open' : 'tag-live'}`}>{r.reviewed ? t('admin.reviewed') : t('admin.reportNew')}</span>
                </div>
                <p className="text-[11px] text-muted mt-1">
                  {t('admin.reportMeta', { club: r.clubId.slice(0, 8), reporter: r.reporterId.slice(0, 8) })} · {new Date(r.createdAt).toLocaleString()}
                </p>
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
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <div className="seg">
            {(['all', 'none', 'pending', 'verified'] as const).map((s) => (
              <button key={s} onClick={() => setKycFilter(s)} className={`seg-tab ${kycFilter === s ? 'active' : ''}`}>
                {s === 'all' ? t('admin.allKyc') : s}
              </button>
            ))}
          </div>
          <button onClick={() => setSortBy(sortBy === 'balance' ? 'name' : 'balance')} className="btn btn-ghost btn-sm">
            {sortBy === 'balance' ? t('admin.sortBalance') : t('admin.sortName')}
          </button>
        </div>
        <ul className="space-y-2.5">
          {shownUsers.slice(0, USER_CAP).map((u) => <UserRow key={u.id} user={u} />)}
        </ul>
        {shownUsers.length > USER_CAP && (
          <p className="text-xs text-muted/70 mt-3 text-center">{t('admin.showingCapped', { shown: USER_CAP, total: shownUsers.length })}</p>
        )}
      </section>
    </div>
  );
}
