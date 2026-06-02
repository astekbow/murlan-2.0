import { useEffect, useState } from 'react';
import { useAdminStore } from '../store/adminStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { dollars } from '../lib/money.ts';
import type { AdminUser } from '../lib/api.ts';

function UserRow({ user }: { user: AdminUser }) {
  const { adjust, setKyc } = useAdminStore();
  const [delta, setDelta] = useState('10');
  const [reason, setReason] = useState('manual');

  const onAdjust = (sign: 1 | -1) => {
    const cents = Math.round((parseFloat(delta) || 0) * 100) * sign;
    if (cents !== 0) void adjust(user.id, cents, reason || 'manual');
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
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <label className="block">
          <span className="field-label">USD</span>
          <input
            type="number"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            className="field w-24"
            title="USD"
          />
        </label>
        <label className="block flex-1 min-w-[140px]">
          <span className="field-label">Arsyeja</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="arsyeja"
            className="field"
          />
        </label>
        <button onClick={() => onAdjust(1)} className="btn btn-green">+ Kredito</button>
        <button onClick={() => onAdjust(-1)} className="btn btn-danger">− Debito</button>
      </div>
    </li>
  );
}

export function AdminView() {
  const { users, withdrawals, matches, error, notice, refresh, approve, reject } = useAdminStore();
  const setView = useUiStore((s) => s.setView);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setView('lobby')} className="btn btn-ghost">← Kthehu te lobi</button>
        <button onClick={() => void refresh()} className="btn btn-ghost">Rifresko</button>
      </div>

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
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">TËRHEQJET NË PRITJE</h2>
        {withdrawals.length === 0 ? (
          <p className="text-sm text-muted italic">Asnjë tërheqje në pritje.</p>
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
                  <button onClick={() => void approve(w.id)} className="btn btn-green">Aprovo</button>
                  <button onClick={() => void reject(w.id)} className="btn btn-danger">Refuzo</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Active matches */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">NDESHJET AKTIVE</h2>
        {matches.length === 0 ? (
          <p className="text-sm text-muted italic">Asnjë ndeshje aktive.</p>
        ) : (
          <ul className="space-y-2.5">
            {matches.map((m) => (
              <li
                key={m.roomId}
                className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] text-sm"
              >
                <span className="font-display font-semibold tracking-wide text-txt">{m.type}</span>
                <span className="text-muted"> · {dollars(m.stakeCents)} · objektivi {m.target} · {m.players.map((p) => p.username ?? `?${p.seat}`).join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Users */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.16s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">PËRDORUESIT ({users.length})</h2>
        <ul className="space-y-2.5">
          {users.map((u) => <UserRow key={u.id} user={u} />)}
        </ul>
      </section>
    </div>
  );
}
