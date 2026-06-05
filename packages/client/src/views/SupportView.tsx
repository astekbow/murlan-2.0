// In-app support / disputes: open a ticket (optionally attach a match id for a
// dispute) and see your tickets + any admin resolution. Disputes are resolved
// against the immutable ledger + provably-fair replay.
import { useEffect, useState } from 'react';
import { supportApi, ApiError, type SupportTicket, type SupportCategory } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';

const CATEGORIES: Array<{ id: SupportCategory; label: string }> = [
  { id: 'match', label: 'Ndeshje / mosmarrëveshje' },
  { id: 'payment', label: 'Pagesa / portofoli' },
  { id: 'account', label: 'Llogaria' },
  { id: 'other', label: 'Tjetër' },
];
const STATUS_LABEL: Record<SupportTicket['status'], string> = { open: 'Hapur', resolved: 'Zgjidhur', closed: 'Mbyllur' };

export function SupportView() {
  const setView = useUiStore((s) => s.setView);
  const [category, setCategory] = useState<SupportCategory>('match');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [matchId, setMatchId] = useState('');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try { setTickets((await supportApi.mine(token)).tickets); } catch { /* ignore */ }
  };
  useEffect(() => { void load(); }, []);

  const submit = async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await supportApi.create(token, { category, subject, message, matchId: matchId.trim() || undefined });
      setSubject(''); setMessage(''); setMatchId('');
      setNotice('Tiketa u dërgua — do të të kthehemi sa më shpejt.');
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Dërgimi i tiketës dështoi.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <button onClick={() => setView('lobby')} className="btn btn-ghost">← Kthehu te lobi</button>

      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">NDIHMË</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">MBËSHTETJA</h1>
        </div>
        <span className="text-4xl opacity-80">🛟</span>
      </section>

      {/* New ticket */}
      <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.06s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">HAP NJË TIKETË</h2>
        <label className="block">
          <span className="field-label">Kategoria</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as SupportCategory)} className="field">
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Tema</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder="P.sh. ndarja e letrave dukej e gabuar" className="field" />
        </label>
        <label className="block">
          <span className="field-label">Mesazhi</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={4} placeholder="Përshkruaj problemin…" className="field resize-y" />
        </label>
        {category === 'match' && (
          <label className="block">
            <span className="field-label">ID e ndeshjes (opsionale)</span>
            <input value={matchId} onChange={(e) => setMatchId(e.target.value)} maxLength={128} placeholder="për mosmarrëveshje ndeshjeje" className="field font-mono" />
          </label>
        )}
        {error && <p className="text-xs text-red-300">{error}</p>}
        {notice && <p className="text-xs text-emerald-300">{notice}</p>}
        <button onClick={() => void submit()} disabled={busy || subject.trim().length < 3 || message.trim().length < 5} className="btn btn-gold">
          {busy ? 'Po dërgohet…' : 'Dërgo tiketën'}
        </button>
      </section>

      {/* My tickets */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">TIKETAT E MIA</h2>
        {tickets.length === 0 ? (
          <p className="text-sm text-muted text-center py-6">Ende nuk ke tiketa.</p>
        ) : (
          <ul className="space-y-2.5">
            {tickets.map((t) => (
              <li key={t.id} className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                <div className="flex items-center gap-2">
                  <span className="font-display font-semibold tracking-wide text-txt truncate flex-1">{t.subject}</span>
                  <span className={`tag ${t.status === 'open' ? 'tag-open' : 'tag-live'}`}>{STATUS_LABEL[t.status]}</span>
                </div>
                <p className="text-xs text-muted mt-1 whitespace-pre-wrap break-words">{t.message}</p>
                {t.matchId && <p className="text-[11px] text-muted/70 mt-1 font-mono">Ndeshja: {t.matchId}</p>}
                {t.adminNote && (
                  <p className="text-xs text-emerald-300/90 mt-2 border-t border-white/10 pt-2">Përgjigje: {t.adminNote}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
