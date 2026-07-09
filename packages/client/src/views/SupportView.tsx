// In-app support / disputes: open a ticket (optionally attach a match id for a
// dispute) and see your tickets + any admin resolution. Disputes are resolved
// against the immutable ledger + provably-fair replay.
import { useCallback, useEffect, useState } from 'react';
import { supportApi, ApiError, type SupportTicket, type SupportCategory } from '../lib/api.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useAuthStore } from '../store/authStore.ts';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

// For errors set OUTSIDE render — translate with the live language.
const tr = (key: string) => translate(key, useLangStore.getState().lang);

// Keys (not resolved labels) so they re-translate when the language changes —
// resolved in-render with the reactive `t`. (A module-level tr() would freeze the
// label at the load-time language.)
const CATEGORIES: Array<{ id: SupportCategory; labelKey: string }> = [
  { id: 'match', labelKey: 'support.catMatch' },
  { id: 'payment', labelKey: 'support.catPayment' },
  { id: 'account', labelKey: 'support.catAccount' },
  { id: 'other', labelKey: 'support.catOther' },
];
const STATUS_KEY: Record<SupportTicket['status'], string> = { open: 'support.statusOpen', resolved: 'support.statusResolved', closed: 'support.statusClosed' };

export function SupportView() {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const [category, setCategory] = useState<SupportCategory>('match');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [matchId, setMatchId] = useState('');
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Distinguish loading / loaded-and-empty / failed for the tickets list so a failed
  // fetch shows an inline error + retry instead of masquerading as "no tickets".
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [supportTab, setSupportTab] = useState<'new' | 'tickets'>('new'); // tabs → each fits without scroll

  const load = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) { setListStatus('ready'); return; }
    setListStatus('loading');
    setListError(null);
    try {
      setTickets((await supportApi.mine(token)).tickets);
      setListStatus('ready');
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : tr('support.loadFailed'));
      setListStatus('error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await supportApi.create(token, { category, subject, message, matchId: matchId.trim() || undefined });
      setSubject(''); setMessage(''); setMatchId('');
      setNotice(t('support.ticketSent'));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('support.submitFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="support-page space-y-4">
      <button onClick={() => setView('lobby')} className="btn btn-ghost">{t('common.backToLobby')}</button>

      <section className="panel p-4 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('support.eyebrow')}</div>
          <h1 className="gold-text font-display font-bold text-2xl tracking-wide leading-tight">{t('support.title')}</h1>
        </div>
        <span className="text-3xl opacity-80" aria-hidden="true">🛟</span>
      </section>

      {/* Tabs so the form and the list each fit the screen without scrolling. */}
      <div className="seg grid grid-cols-2" role="group" aria-label={t('support.title')}>
        <button type="button" aria-pressed={supportTab === 'new'} onClick={() => setSupportTab('new')} className={`seg-tab text-center ${supportTab === 'new' ? 'active' : ''}`}>{t('support.openTicket')}</button>
        <button type="button" aria-pressed={supportTab === 'tickets'} onClick={() => setSupportTab('tickets')} className={`seg-tab text-center ${supportTab === 'tickets' ? 'active' : ''}`}>{t('support.myTickets')}</button>
      </div>

      <div className="support-body space-y-4">
      {/* New ticket */}
      {supportTab === 'new' && (
      <section className="panel p-5 animate-rise space-y-3" style={{ animationDelay: '.06s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('support.openTicket')}</h2>
        <label className="block">
          <span className="field-label">{t('support.category')}</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as SupportCategory)} className="field">
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{t(c.labelKey)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('support.subject')}</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder={t('support.subjectPlaceholder')} className="field" />
        </label>
        <label className="block">
          <span className="field-label">{t('support.message')}</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={4} placeholder={t('support.messagePlaceholder')} className="field resize-y support-ta" />
        </label>
        {category === 'match' && (
          <label className="block">
            <span className="field-label">{t('support.matchIdLabel')}</span>
            <input value={matchId} onChange={(e) => setMatchId(e.target.value)} maxLength={128} placeholder={t('support.matchIdPlaceholder')} className="field font-mono" />
          </label>
        )}
        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        {notice && <p role="status" className="text-xs text-emerald-300">{notice}</p>}
        <button onClick={() => void submit()} disabled={busy || subject.trim().length < 3 || message.trim().length < 5} className="btn btn-gold">
          {busy ? t('support.sending') : t('support.submit')}
        </button>
      </section>
      )}

      {/* My tickets */}
      {supportTab === 'tickets' && (
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('support.myTickets')}</h2>
        {listStatus === 'loading' ? (
          <div className="text-center py-6">
            <div className="text-3xl mb-2 opacity-60 animate-pulse">🛟</div>
            <p className="text-sm text-muted">{t('support.loadingTickets')}</p>
          </div>
        ) : listStatus === 'error' ? (
          <EmptyState
            tone="error"
            message={listError ?? t('support.loadFailed')}
            action={<button onClick={() => void load()} className="btn btn-gold btn-sm">{t('app.retry')}</button>}
          />
        ) : tickets.length === 0 ? (
          <p className="text-sm text-muted text-center py-6">{t('support.noTickets')}</p>
        ) : (
          <ul className="space-y-2.5">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
                <div className="flex items-center gap-2">
                  <span className="font-display font-semibold tracking-wide text-txt truncate flex-1">{ticket.subject}</span>
                  {/* One convention: amber=open/waiting, green=resolved/done, muted=closed. */}
                  <span className={`tag ${ticket.status === 'open' ? 'tag-pending' : ticket.status === 'closed' ? 'tag-muted' : 'tag-open'}`}>{t(STATUS_KEY[ticket.status])}</span>
                </div>
                <p className="text-xs text-muted mt-1 whitespace-pre-wrap break-words">{ticket.message}</p>
                {ticket.matchId && <p className="text-[11px] text-muted/70 mt-1 font-mono">{t('support.matchLabel', { id: ticket.matchId })}</p>}
                {ticket.adminNote && (
                  <p className="text-xs text-emerald-300/90 mt-2 border-t border-white/10 pt-2">{t('support.replyLabel', { note: ticket.adminNote })}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
      </div>
    </div>
  );
}