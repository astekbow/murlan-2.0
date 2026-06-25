import { useEffect, useRef, useState } from 'react';
import { useAdminStore } from '../store/adminStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { dollars } from '../lib/money.ts';
import { adminApi, rankedApi, ApiError } from '../lib/api.ts';
import type { AdminUser, AdminMatch, SupportTicket, AdminActionRecord, Transaction, AdminAccountState, AdminChatReport, RevenueBreakdown, SeasonDTO } from '../lib/api.ts';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { useT } from '../lib/i18n.ts';

// The grantable admin scopes (must mirror ADMIN_PERMISSIONS on the server). An
// admin with NO scopes is a full admin; assigning any scope restricts them.
const ADMIN_PERMS = ['adjust_balance', 'approve_withdrawals', 'manage_accounts', 'manage_admins', 'moderate_chat', 'void_matches', 'view_revenue'] as const;

type AdminTab = 'overview' | 'withdrawals' | 'players' | 'matches' | 'support' | 'moderation' | 'audit';

// ---- A single player: a COLLAPSED summary you can expand to all the controls. ----
// (Collapsing keeps the list scannable; you only see one player's actions at a time.)
function UserRow({ user }: { user: AdminUser }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { adjust, setRole } = useAdminStore();
  const myId = useAuthStore((s) => s.user?.id);
  const isSelf = user.id === myId; // can't edit your own scopes (server rejects too)
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState('10');
  const [reason, setReason] = useState('manual');
  const [perms, setPerms] = useState<string[]>(user.permissions ?? []);

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

  // One-click "clear liability": debit the EXACT current balance so it lands on $0.
  const onClearLiability = async () => {
    if (user.balanceCents <= 0) return;
    if (!(await confirm({
      title: t('admin.clearLiability'),
      message: t('admin.confirmClearM', { amount: dollars(user.balanceCents), user: user.username }),
      danger: true,
    }))) return;
    void adjust(user.id, -user.balanceCents, reason || 'clear liability');
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

  const mute24h = async () => {
    if (!(await confirm({ title: t('admin.mute'), message: t('admin.confirmMuteM', { user: user.username }), danger: true }))) return;
    const token = useAuthStore.getState().accessToken;
    if (token) { try { await adminApi.muteUser(token, user.id, 24 * 60 * 60 * 1000); } catch { /* surfaced elsewhere */ } }
  };
  const unmute = async () => {
    if (!(await confirm({ title: t('admin.unmute'), message: t('admin.confirmUnmuteM', { user: user.username }) }))) return;
    const token = useAuthStore.getState().accessToken;
    if (token) { try { await adminApi.unmuteUser(token, user.id); } catch { /* surfaced elsewhere */ } }
  };

  return (
    <li className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] overflow-hidden">
      {/* Summary header — click to expand this player's actions. */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[.03] transition-colors"
      >
        <span className={`shrink-0 text-muted/60 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>▸</span>
        <span className="min-w-0 flex-1">
          <span className="font-display font-semibold tracking-wide text-txt">{user.username}</span>
          {user.role === 'admin' && <span className="tag tag-open ml-2 align-middle">admin</span>}
          <span className="block text-[11px] text-muted/70 truncate">{user.email}</span>
        </span>
        <span className="chip shrink-0"><span className="coin" />{dollars(user.balanceCents)}</span>
      </button>

      {open && (
        <div className="px-4 pb-3 space-y-3 border-t border-white/10 pt-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => void onToggleRole()} className={`btn ml-auto ${user.role === 'admin' ? 'btn-danger' : 'btn-ghost'}`}>
              {user.role === 'admin' ? t('admin.removeAdmin') : t('admin.makeAdmin')}
            </button>
          </div>

          <div className="flex items-end gap-2 flex-wrap">
            <label className="block">
              <span className="field-label">USD</span>
              <input type="number" min="0" max="50000" step="1" value={delta} onChange={(e) => setDelta(e.target.value)} className="field w-24" title="USD" />
            </label>
            <label className="block flex-1 min-w-[140px]">
              <span className="field-label">{t('admin.reason')}</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('admin.reasonPlaceholder')} className="field" />
            </label>
            <button onClick={() => void onAdjust(1)} className="btn btn-green">{t('admin.credit')}</button>
            <button onClick={() => void onAdjust(-1)} className="btn btn-danger">{t('admin.debit')}</button>
            {user.balanceCents > 0 && (
              <button onClick={() => void onClearLiability()} className="btn btn-outline" title={t('admin.clearLiability')}>{t('admin.clearLiability')}</button>
            )}
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

          {user.role === 'admin' && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="field-label">{t('admin.permsLabel')}:</span>
              {ADMIN_PERMS.map((p) => {
                const on = perms.includes(p);
                return (
                  <button key={p} onClick={() => void togglePerm(p)} disabled={isSelf} aria-pressed={on} className={`btn btn-xs ${on ? 'btn-gold' : 'btn-ghost'}`} title={t(`admin.perm.${p}`)}>
                    {t(`admin.perm.${p}`)}
                  </button>
                );
              })}
              <span className="text-[11px] text-muted/70">{isSelf ? t('admin.permsSelf') : perms.length === 0 ? t('admin.permsFull') : t('admin.permsScoped', { n: perms.length })}</span>
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
        </div>
      )}
      {dialog}
    </li>
  );
}

// One in-progress staked match, with an admin void control (refund all stakes, end match).
function MatchRow({ m }: { m: AdminMatch }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const onVoid = async () => {
    if (!(await confirm({
      title: t('admin.voidMatch'),
      message: t('admin.confirmVoidM', { type: m.type, stake: dollars(m.stakeCents) }),
      danger: true,
      confirmLabel: t('admin.voidMatch'),
    }))) return;
    setBusy(true);
    const token = useAuthStore.getState().accessToken;
    if (token) {
      try {
        await adminApi.voidMatch(token, m.roomId, reason.trim() || t('admin.voidDefaultReason'));
        await useAdminStore.getState().refresh();
      } catch { /* surfaced via the store's error banner on next refresh */ }
    }
    setBusy(false);
  };

  return (
    <li className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] text-sm space-y-2">
      <div>
        <span className="font-display font-semibold tracking-wide text-txt">{m.type}</span>
        <span className="text-muted"> · {dollars(m.stakeCents)} · {t('admin.target')} {m.target} · {m.players.map((p) => p.username ?? `?${p.seat}`).join(', ')}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('admin.voidReason')} aria-label={t('admin.voidReason')} className="field flex-1 min-w-[160px]" />
        <button onClick={() => void onVoid()} disabled={busy} className="btn btn-danger btn-sm shrink-0">{busy ? t('admin.voiding') : t('admin.voidMatch')}</button>
      </div>
      {dialog}
    </li>
  );
}

// Animated placeholder rows shown while an admin list loads (instead of a blank panel).
// Inline Tailwind only — `animate-pulse` + faint bars. aria-busy/role flag it to AT.
function SkeletonRows({ rows = 4 }: { rows?: number }) {
  const t = useT();
  return (
    <ul className="space-y-2.5" aria-busy="true" aria-label={t('admin.loading')}>
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="rounded-xl px-4 py-3 border border-white/10 bg-white/[.02] animate-pulse">
          <div className="flex items-center justify-between gap-3">
            <div className="h-3.5 w-1/3 bg-white/5 rounded" />
            <div className="h-3.5 w-16 bg-white/5 rounded" />
          </div>
          <div className="h-2.5 w-1/2 bg-white/5 rounded mt-2" />
        </li>
      ))}
    </ul>
  );
}

// The reject-reason body for the withdrawal Reject dialog: quick-pick chips that FILL
// the free-text field (still fully editable). Manages its own input state and reports
// every change up via `onChange` (the parent stores it in a ref read after confirm).
function RejectReasonField({ onChange }: { onChange: (v: string) => void }) {
  const t = useT();
  const [value, setValue] = useState('');
  const presets: Array<{ key: string; label: string }> = [
    { key: 'badAddress', label: t('admin.rejectPreset.badAddress') },
    { key: 'kycFailed', label: t('admin.rejectPreset.kycFailed') },
    { key: 'tooFrequent', label: t('admin.rejectPreset.tooFrequent') },
    { key: 'flagged', label: t('admin.rejectPreset.flagged') },
  ];
  const set = (v: string) => { setValue(v); onChange(v); };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="field-label">{t('admin.rejectPresets')}</span>
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => set(p.label)}
            aria-pressed={value === p.label}
            className={`btn btn-xs ${value === p.label ? 'btn-gold' : 'btn-ghost'}`}
          >{p.label}</button>
        ))}
        {/* "Other" clears the field so the admin types their own reason. */}
        <button type="button" onClick={() => set('')} className="btn btn-xs btn-ghost">{t('admin.rejectPreset.other')}</button>
      </div>
      <input
        autoFocus
        maxLength={500}
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={t('admin.rejectReasonPlaceholder')}
        className="field w-full"
      />
    </div>
  );
}

// A clickable overview tile: a count + label that jumps to its tab.
function StatCard({ label, value, accent, onClick }: { label: string; value: string | number; accent?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="panel p-4 text-left hover:border-gold transition-colors flex flex-col gap-1">
      <span className={`font-display font-bold text-3xl leading-none tabular-nums ${accent ? 'gold-text' : 'text-txt'}`}>{value}</span>
      <span className="text-[11px] uppercase tracking-wide text-muted/80">{label}</span>
    </button>
  );
}

// Ranked-season control: shows the active season + opens a new one. Starting a season
// archives the current one and soft-resets every player's MMR, so it's confirmed (danger).
function RankedSeasonCard() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const [season, setSeason] = useState<SeasonDTO | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void rankedApi.season().then((r) => setSeason(r.season)).catch(() => {}); }, []);

  const start = async () => {
    const nm = name.trim();
    if (!nm || busy) return;
    if (!(await confirm({ title: t('admin.ranked.startT'), message: t('admin.ranked.startM'), confirmLabel: t('admin.ranked.start'), danger: true }))) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy(true);
    try {
      const { season: s } = await rankedApi.createSeason(token, nm);
      setSeason(s);
      setName('');
      useGameStore.setState({ toast: t('admin.ranked.started', { name: nm }), toastKind: 'success' });
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('err.generic'), toastKind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel p-4 space-y-3">
      {dialog}
      <h3 className="font-display font-semibold text-gold-hi text-sm">{t('admin.ranked.title')}</h3>
      <p className="text-sm text-muted">
        {season ? t('admin.ranked.current', { n: season.number, name: season.name }) : t('admin.ranked.none')}
      </p>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="block flex-1 min-w-[12rem]">
          <span className="field-label">{t('admin.ranked.newName')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('admin.ranked.newNamePh')} className="field w-full"
            onKeyDown={(e) => { if (e.key === 'Enter') void start(); }} />
        </label>
        <button onClick={() => void start()} disabled={busy || !name.trim()} className="btn btn-gold">
          {busy ? t('admin.ranked.starting') : t('admin.ranked.start')}
        </button>
      </div>
      <p className="text-[11px] text-muted/70">{t('admin.ranked.hint')}</p>
    </section>
  );
}

export function AdminView() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { users, withdrawals, matches, revenueCents, error, notice, loading, refresh, approve, reject, treasury, treasuryLoading, loadTreasury,
    userSort, userOffset, userTotal, userPageSize, setUserQuery, setUserSort, setUserPage } = useAdminStore();
  const setView = useUiStore((s) => s.setView);
  // Captures the (optional) rejection reason typed in the reject confirm dialog. A ref —
  // not state — so the value read after `await confirm(...)` is the latest, not a stale
  // closure (the input lives inside the dialog message which re-renders independently).
  const rejectReasonRef = useRef('');
  const [tab, setTab] = useState<AdminTab>('overview');
  const [queryInput, setQueryInput] = useState(''); // local input; debounced into the store search
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [auditLog, setAuditLog] = useState<AdminActionRecord[]>([]);
  const [reports, setReports] = useState<AdminChatReport[]>([]);
  const [revenue, setRevenue] = useState<RevenueBreakdown | null>(null);
  // First-load flag for the depth lists (support/audit/reports) so they show skeleton
  // rows the first time instead of an empty-state flash; stays false on later refreshes.
  const [depthLoading, setDepthLoading] = useState(true);

  const loadDepth = () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setDepthLoading(true);
    void Promise.allSettled([
      adminApi.support(token).then((r) => setTickets(r.tickets)),
      adminApi.audit(token).then((r) => setAuditLog(r.actions)),
      adminApi.chatReports(token).then((r) => setReports(r.reports)),
      adminApi.revenueBreakdown(token).then(setRevenue),
    ]).finally(() => setDepthLoading(false));
  };

  useEffect(() => { void refresh(); loadDepth(); }, [refresh]);

  // Debounce the search box into the store (which fetches the matching page server-side).
  useEffect(() => {
    const id = setTimeout(() => setUserQuery(queryInput.trim()), 300);
    return () => clearTimeout(id);
  }, [queryInput, setUserQuery]);

  const refreshAll = () => { void refresh(); loadDepth(); };

  const resolveTicket = async (id: string) => {
    if (!(await confirm({ title: t('admin.resolveTicket'), message: t('admin.confirmResolveM') }))) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    await adminApi.resolveTicket(token, id, 'resolved');
    loadDepth();
  };

  const openTickets = tickets.filter((tk) => tk.status === 'open');
  const newReports = reports.filter((r) => !r.reviewed);

  // `users` is already the server-filtered/sorted page; pagination is server-side.
  const pageStart = userTotal === 0 ? 0 : userOffset + 1;
  const pageEnd = userOffset + users.length;

  const TABS: Array<{ id: AdminTab; label: string; badge?: number }> = [
    { id: 'overview', label: t('admin.tab.overview') },
    { id: 'withdrawals', label: t('admin.tab.withdrawals'), badge: withdrawals.length },
    { id: 'players', label: t('admin.tab.players') },
    { id: 'matches', label: t('admin.tab.matches'), badge: matches.length },
    { id: 'support', label: t('admin.tab.support'), badge: openTickets.length },
    { id: 'moderation', label: t('admin.tab.moderation'), badge: newReports.length },
    { id: 'audit', label: t('admin.tab.audit') },
  ];

  return (
    <div className="space-y-4">
      <h1 className="sr-only">{t('admin.panelTitle')}</h1>
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>
        <button onClick={refreshAll} className="btn btn-ghost">{t('common.refresh')}</button>
      </div>
      {dialog}

      {(error || notice) && (
        <div className={`text-sm rounded-lg px-3 py-2 ${error ? 'text-red-300 bg-suit/15 border border-suit/40' : 'text-emerald-200 bg-emerald-500/10 border border-emerald-500/40'}`} role="status">
          {error || notice}
        </div>
      )}

      {/* Tab bar — scrollable on mobile; badges flag what needs action. */}
      <nav className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1" aria-label={t('admin.panelTitle')}>
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            aria-current={tab === tb.id ? 'page' : undefined}
            className={`btn btn-sm shrink-0 whitespace-nowrap ${tab === tb.id ? 'btn-gold' : 'btn-ghost'}`}
          >
            {tb.label}
            {tb.badge ? <span className="ml-1.5 tag tag-live align-middle">{tb.badge}</span> : null}
          </button>
        ))}
      </nav>

      {/* ── Overview ── */}
      {tab === 'overview' && (
        <div className="space-y-4 animate-rise">
          <section className="panel p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('admin.revenueEyebrow')}</div>
                <h2 className="gold-text font-display font-bold text-2xl tracking-wide leading-none">{t('admin.revenueTitle')}</h2>
                <p className="text-[11px] text-muted/70 mt-1">{t('admin.revenueNote')}</p>
              </div>
              <div className="text-right">
                <div className="font-display font-semibold tracking-wide text-gold-hi text-3xl leading-none">{revenueCents == null ? '—' : dollars(revenueCents)}</div>
                {revenue && <div className="text-[11px] text-muted/80 mt-1">{t('admin.liability')}: <b className="text-txt">{dollars(revenue.payoutLiabilityCents)}</b></div>}
              </div>
            </div>
            {revenue && revenue.rakeCount > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 pt-1 border-t border-white/10">
                <div>
                  <div className="field-label mb-1.5">{t('admin.revenueByType')}</div>
                  <ul className="space-y-1">
                    {revenue.byType.map((r) => (
                      <li key={r.type} className="flex items-center justify-between text-sm">
                        <span className="text-muted">{r.type} <span className="text-muted/60">· {r.matchCount}</span></span>
                        <b className="text-gold-hi tabular-nums">{dollars(r.rakeCents)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="field-label mb-1.5">{t('admin.revenueByDay')}</div>
                  {/* Trend: a compact bar per day (height ∝ rake), newest on the right. */}
                  {(() => {
                    const days = [...revenue.byDay].slice(0, 30).reverse(); // oldest→newest L→R
                    const max = Math.max(1, ...days.map((d) => d.rakeCents));
                    return days.length > 0 ? (
                      <div className="flex items-end gap-0.5 h-20 mb-2" role="img" aria-label={t('admin.revenueByDay')}>
                        {days.map((d) => (
                          <div key={d.date} className="flex-1 bg-gold/70 rounded-t hover:bg-gold transition-colors"
                            style={{ height: `${Math.max(3, Math.round((d.rakeCents / max) * 100))}%` }}
                            title={`${d.date}: ${dollars(d.rakeCents)} · ${d.matchCount}`} />
                        ))}
                      </div>
                    ) : null;
                  })()}
                  <ul className="space-y-1 max-h-32 overflow-y-auto -mr-1 pr-1">
                    {revenue.byDay.map((r) => (
                      <li key={r.date} className="flex items-center justify-between text-sm">
                        <span className="text-muted tabular-nums">{r.date} <span className="text-muted/60">· {r.matchCount}</span></span>
                        <b className="text-gold-hi tabular-nums">{dollars(r.rakeCents)}</b>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>

          <p className="text-[11px] text-muted/70 px-1">{t('admin.overviewHint')}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label={t('admin.tab.withdrawals')} value={withdrawals.length} accent={withdrawals.length > 0} onClick={() => setTab('withdrawals')} />
            <StatCard label={t('admin.tab.matches')} value={matches.length} onClick={() => setTab('matches')} />
            <StatCard label={t('admin.tab.support')} value={openTickets.length} accent={openTickets.length > 0} onClick={() => setTab('support')} />
            <StatCard label={t('admin.tab.moderation')} value={newReports.length} accent={newReports.length > 0} onClick={() => setTab('moderation')} />
            <StatCard label={t('admin.totalPlayers')} value={users.length} onClick={() => setTab('players')} />
          </div>

          {/* Treasury: where ALL the money is. On-demand (hits Binance + TronGrid). */}
          <section className="panel p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display font-semibold text-gold-hi text-sm">{t('admin.treasury')}</h3>
              <button onClick={() => void loadTreasury()} disabled={treasuryLoading} className="btn btn-ghost btn-sm">
                {treasuryLoading ? t('admin.treasuryLoading') : treasury ? t('admin.treasuryRefresh') : t('admin.treasuryLoad')}
              </button>
            </div>
            {treasury ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted">{t('admin.treasuryHouseRake')}</span><b className="text-gold-hi tabular-nums">{dollars(treasury.houseRakeCents)}</b></div>
                  <div className="flex justify-between"><span className="text-muted">{t('admin.treasuryLiabilities')}</span><span className="tabular-nums">{dollars(treasury.playerLiabilitiesCents)}</span></div>
                  <div className="flex justify-between"><span className="text-muted">{t('admin.treasuryDepositFunds')}</span><span className="tabular-nums">{treasury.depositAddressFundsCents == null ? '—' : dollars(treasury.depositAddressFundsCents)}{treasury.depositFundsPartial ? ' *' : ''}</span></div>
                  <div className="flex justify-between"><span className="text-muted">{t('admin.treasuryBinance')}</span><span className="tabular-nums">{treasury.binanceFreeCents == null ? '—' : dollars(treasury.binanceFreeCents)}</span></div>
                  <div className="flex justify-between"><span className="text-muted">{t('admin.treasuryPending')}</span><span className="tabular-nums">{dollars(treasury.pendingWithdrawalsCents)}</span></div>
                </div>
                {treasury.coverageOk != null && (
                  <p className={`text-[12px] font-semibold ${treasury.coverageOk ? 'text-emerald-300' : 'text-red-300'}`}>
                    {treasury.coverageOk ? t('admin.treasuryCoverageOk') : t('admin.treasuryCoverageBad')}
                  </p>
                )}
                {treasury.depositFundsPartial && <p className="text-[11px] text-muted/70">* {t('admin.treasuryPartial')}</p>}
              </>
            ) : (
              <p className="text-xs text-muted/70 italic">{t('admin.treasuryHint')}</p>
            )}
          </section>

          {/* Ranked season management (open/reset the competitive ladder). */}
          <RankedSeasonCard />
        </div>
      )}

      {/* ── Withdrawals ── */}
      {tab === 'withdrawals' && (
        <section className="panel p-5 animate-rise">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('admin.pendingWithdrawals')}</h2>
          {loading && withdrawals.length === 0 ? (
            <SkeletonRows rows={3} />
          ) : withdrawals.length === 0 ? (
            <p className="text-sm text-muted italic">{t('admin.noPendingWithdrawals')}</p>
          ) : (
            <ul className="space-y-2.5">
              {withdrawals.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                  <span className="text-sm min-w-0">
                    <b className="text-txt">{dollars(w.amountCents)}</b>
                    <span className="text-muted"> → <span className="break-all">{w.destination}</span></span>
                    <span className="block text-[11px] text-muted/80">{w.username ?? '?'} · {new Date(w.createdAt).toLocaleString()}</span>
                  </span>
                  <span className="flex gap-2 shrink-0">
                    <button onClick={async () => { if (await confirm({ title: t('admin.approve'), message: t('admin.confirmApproveM', { amount: dollars(w.amountCents), dest: w.destination }) })) void approve(w.id); }} className="btn btn-green">{t('admin.approve')}</button>
                    <button
                      onClick={async () => {
                        rejectReasonRef.current = '';
                        const ok = await confirm({
                          title: t('admin.reject'),
                          danger: true,
                          message: (
                            <div className="space-y-2">
                              <p>{t('admin.confirmRejectM', { amount: dollars(w.amountCents) })}</p>
                              <RejectReasonField onChange={(v) => { rejectReasonRef.current = v; }} />
                            </div>
                          ),
                        });
                        if (ok) void reject(w.id, rejectReasonRef.current.trim() || undefined);
                      }}
                      className="btn btn-danger"
                    >{t('admin.reject')}</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Players ── (server-side search / sort / pagination) */}
      {tab === 'players' && (
        <section className="panel p-5 animate-rise">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('admin.users', { n: userTotal })}</h2>
            <input value={queryInput} onChange={(e) => setQueryInput(e.target.value)} placeholder={t('admin.searchUsers')} aria-label={t('admin.searchUsers')} autoCapitalize="none" autoCorrect="off" spellCheck={false} className="field max-w-[220px]" />
          </div>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <button onClick={() => setUserSort(userSort === 'balance' ? 'name' : 'balance')} className="btn btn-ghost btn-sm">
              {userSort === 'balance' ? t('admin.sortBalance') : t('admin.sortName')}
            </button>
          </div>
          {loading && users.length === 0 ? (
            <SkeletonRows rows={5} />
          ) : (
            <ul className="space-y-2">
              {users.map((u) => <UserRow key={u.id} user={u} />)}
            </ul>
          )}
          {userTotal > userPageSize && (
            <div className="flex items-center justify-center gap-3 mt-3">
              <button disabled={userOffset === 0} onClick={() => setUserPage(userOffset - userPageSize)} className="btn btn-ghost btn-sm">{t('admin.prev')}</button>
              <span className="text-xs text-muted/70">{t('admin.showingRange', { from: pageStart, to: pageEnd, total: userTotal })}</span>
              <button disabled={pageEnd >= userTotal} onClick={() => setUserPage(userOffset + userPageSize)} className="btn btn-ghost btn-sm">{t('admin.next')}</button>
            </div>
          )}
        </section>
      )}

      {/* ── Active matches ── */}
      {tab === 'matches' && (
        <section className="panel p-5 animate-rise">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('admin.activeMatches')}</h2>
          {loading && matches.length === 0 ? (
            <SkeletonRows rows={3} />
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted italic">{t('admin.noActiveMatches')}</p>
          ) : (
            <ul className="space-y-2.5">{matches.map((m) => <MatchRow key={m.roomId} m={m} />)}</ul>
          )}
        </section>
      )}

      {/* ── Support ── */}
      {tab === 'support' && (
        <section className="panel p-5 animate-rise">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3 flex items-center gap-2">
            {t('admin.support')}
            {openTickets.length > 0 && <span className="tag tag-live">{openTickets.length}</span>}
          </h2>
          {depthLoading && tickets.length === 0 ? (
            <SkeletonRows rows={4} />
          ) : tickets.length === 0 ? (
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
                  {tk.status === 'open' && <button onClick={() => void resolveTicket(tk.id)} className="btn btn-gold btn-sm mt-2">{t('admin.resolveTicket')}</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Moderation ── */}
      {tab === 'moderation' && (
        <section className="panel p-5 animate-rise">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3 flex items-center gap-2">
            {t('admin.moderation')}
            {newReports.length > 0 && <span className="tag tag-live">{newReports.length}</span>}
          </h2>
          {depthLoading && reports.length === 0 ? (
            <SkeletonRows rows={4} />
          ) : reports.length === 0 ? (
            <p className="text-sm text-muted italic">{t('admin.noReports')}</p>
          ) : (
            <ul className="space-y-2.5 max-h-[60vh] overflow-y-auto -mr-1 pr-1">
              {reports.slice(0, 50).map((r) => (
                <li key={r.id} className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-display font-semibold tracking-wide text-txt text-sm break-words">{r.reason || t('admin.reportNoReason')}</span>
                    <span className={`tag ${r.reviewed ? 'tag-open' : 'tag-live'}`}>{r.reviewed ? t('admin.reviewed') : t('admin.reportNew')}</span>
                  </div>
                  {/* The reported message itself (joined server-side) — what the admin is judging. */}
                  <div className="mt-2 rounded-lg border border-white/10 bg-white/[.03] px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted/70">
                      {t('admin.reportedMsg')}
                      {r.authorUsername ? <span className="text-muted/90"> · {t('admin.reportAuthor', { user: r.authorUsername })}</span> : null}
                    </div>
                    {r.messageText != null ? (
                      <p className="text-sm text-txt mt-0.5 break-words whitespace-pre-wrap">{r.messageText}</p>
                    ) : (
                      <p className="text-xs text-muted/70 italic mt-0.5">{t('admin.reportMsgGone')}</p>
                    )}
                  </div>
                  <p className="text-[11px] text-muted mt-1">{t('admin.reportMeta', { club: r.clubId.slice(0, 8), reporter: r.reporterId.slice(0, 8) })} · {new Date(r.createdAt).toLocaleString()}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Audit ── */}
      {tab === 'audit' && (
        <section className="panel p-5 animate-rise">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('admin.auditLog')}</h2>
          {depthLoading && auditLog.length === 0 ? (
            <SkeletonRows rows={6} />
          ) : auditLog.length === 0 ? (
            <p className="text-sm text-muted italic">{t('admin.noAudit')}</p>
          ) : (
            <ul className="space-y-1.5 max-h-[70vh] overflow-y-auto -mr-1 pr-1">
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
      )}
    </div>
  );
}
