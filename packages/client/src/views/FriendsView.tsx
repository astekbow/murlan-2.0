import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { friendsApi, walletApi, clubsApi, ApiError, type FriendEntry, type UserSearchResult, type FriendFeedEntry } from '../lib/api.ts';
import { AvatarFace } from '../components/ui/AvatarFace.tsx';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useWalletStore } from '../store/walletStore.ts';
import { dollars } from '../lib/money.ts';
import { SkeletonList } from '../components/ui/Skeleton.tsx';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { useT } from '../lib/i18n.ts';

/** Detailed presence label for a friend (offline / online / in a room / in a live match). */
function presenceText(entry: FriendEntry, t: (k: string) => string): string {
  if (!entry.online) return t('common.offline');
  if (entry.activity === 'match') return t('friends.inMatch');
  if (entry.activity === 'room') return t('friends.inRoom');
  return t('common.online');
}

/** Status-dot colour: gray offline, gold in a match, blue in a room, green idle-online. */
function presenceDot(entry: FriendEntry): string {
  if (!entry.online) return 'bg-white/25';
  if (entry.activity === 'match') return 'bg-amber-400';
  if (entry.activity === 'room') return 'bg-sky-400';
  return 'bg-emerald-400';
}

/** Compact, language-neutral relative time (s/m/h/d) for the activity feed. */
function relTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function FriendsView() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const setView = useUiStore((s) => s.setView);
  const landscape = useLandscapePage();
  const [selectedId, setSelectedId] = useState<string | null>(null); // landscape master-detail

  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [feed, setFeed] = useState<FriendFeedEntry[]>([]); // friends' recent activity (wins)
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  // Live username search (debounced) for the add-friend input.
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false); // whether the current query has resolved (for no-results)
  // One mutating action at a time: disables the row buttons + pauses the poll so a rapid
  // click can't double-fire and a stale 8s refetch can't clobber a just-made change.
  const [acting, setActing] = useState(false);
  const actingRef = useRef(false);

  // Send-money-to-a-friend modal.
  const [sendTo, setSendTo] = useState<FriendEntry | null>(null);
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const balanceCents = useWalletStore((s) => s.balanceCents);
  useEffect(() => { void useWalletStore.getState().refresh(); }, []); // load my balance for the transfer UI

  // Whether the caller is in a club → enables the per-friend "invite to club" action.
  const [inClub, setInClub] = useState(false);
  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    clubsApi.mine(token).then((r) => setInClub(!!r.club)).catch(() => setInClub(false));
  }, []);

  const sendMoney = async () => {
    if (!sendTo || sending) return;
    const usd = parseFloat(amount.replace(',', '.'));
    if (!Number.isFinite(usd) || usd <= 0) {
      useGameStore.setState({ toast: t('friends.sendBadAmount'), toastKind: 'error' });
      return;
    }
    const cents = Math.round(usd * 100);
    if (cents > balanceCents) {
      useGameStore.setState({ toast: t('friends.sendInsufficient'), toastKind: 'error' });
      return;
    }
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setSending(true);
    try {
      await walletApi.transfer(token, sendTo.user.id, cents);
      useGameStore.setState({ toast: t('friends.sendSuccess', { amount: dollars(cents), name: sendTo.user.username }), toastKind: 'success' });
      setSendTo(null);
      setAmount('');
      await useWalletStore.getState().refresh();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('friends.sendErr'), toastKind: 'error' });
    } finally {
      setSending(false);
    }
  };

  const load = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) {
      setFriends([]);
      setLoading(false);
      return;
    }
    try {
      const { friends } = await friendsApi.list(token);
      setFriends(friends);
      // Friends' recent activity (best-effort — never blocks the friends list).
      const f = await friendsApi.feed(token).catch(() => ({ feed: [] as FriendFeedEntry[] }));
      setFeed(f.feed);
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('friends.errLoad'), toastKind: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll so presence dots stay fresh while the page is open (8s). Skip a tick while a
    // mutation is in flight so it can't overwrite the just-changed state with a stale
    // snapshot. (Friend request/answer/unfriend also push a socket event for INSTANT
    // refresh — see socialRev below — so the poll is now just a presence backstop.)
    const id = setInterval(() => { if (!actingRef.current) void load(); }, 8_000);
    return () => clearInterval(id);
  }, [load]);

  // Instant refresh when a friend event concerning me arrives over the socket.
  const socialRev = useGameStore((s) => s.socialRev);
  useEffect(() => {
    if (socialRev > 0 && !actingRef.current) void load();
  }, [socialRev, load]);

  // Run one mutating friend action at a time (guard + busy flag), then refresh.
  const act = useCallback(async (fn: () => Promise<void>, errKey: string) => {
    const token = useAuthStore.getState().accessToken;
    if (!token || actingRef.current) return;
    actingRef.current = true;
    setActing(true);
    try {
      await fn();
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t(errKey), toastKind: 'error' });
    } finally {
      actingRef.current = false;
      setActing(false);
    }
  }, [load, t]);

  // Debounced live search as the user types (≥2 chars, ~250ms). A seq guard drops a stale
  // response when a newer query supersedes it. <2 chars clears the results list.
  const searchSeq = useRef(0);
  useEffect(() => {
    const q = username.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      setSearched(false);
      return;
    }
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setSearching(true);
    const seq = ++searchSeq.current;
    const id = setTimeout(async () => {
      try {
        const { users } = await friendsApi.search(token, q);
        if (seq !== searchSeq.current) return; // a newer query won
        setResults(users);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) { setSearching(false); setSearched(true); }
      }
    }, 250);
    return () => clearTimeout(id);
  }, [username]);

  // Send a friend request to a specific username (from the search results or the input).
  const addByUsername = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy(true);
    try {
      await friendsApi.request(token, trimmed);
      setUsername('');
      setResults([]);
      setSearched(false);
      useGameStore.setState({ toast: t('friends.requestSent'), toastKind: 'success' });
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('friends.errRequest'), toastKind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Enter-to-add (manual) still works — adds whatever is typed verbatim.
  const addFriend = () => addByUsername(username);

  const respond = (id: string, accept: boolean) =>
    act(() => friendsApi.respond(useAuthStore.getState().accessToken!, id, accept).then(() => undefined), 'friends.errAction');

  const remove = async (id: string) => {
    if (!(await confirm({ title: t('common.remove'), message: t('friends.confirmRemoveM'), danger: true, confirmLabel: t('common.remove') }))) return;
    await act(() => friendsApi.remove(useAuthStore.getState().accessToken!, id).then(() => undefined), 'friends.errRemove');
  };

  const block = async (userId: string) => {
    if (!(await confirm({ title: t('friends.block'), message: t('friends.confirmBlockM'), danger: true, confirmLabel: t('friends.block') }))) return;
    await act(async () => {
      await friendsApi.block(useAuthStore.getState().accessToken!, userId);
      useGameStore.setState({ toast: t('friends.userBlocked'), toastKind: 'success' });
    }, 'friends.errBlock');
  };

  const unblock = (userId: string) =>
    act(() => friendsApi.unblock(useAuthStore.getState().accessToken!, userId).then(() => undefined), 'friends.errUnblock');

  const incoming = friends.filter((f) => f.direction === 'incoming');
  const outgoing = friends.filter((f) => f.direction === 'outgoing');
  const accepted = friends.filter((f) => f.direction === 'friends');
  const blocked = friends.filter((f) => f.direction === 'blocked');

  const inRoom = useGameStore.getState().room !== null;

  // Online friends first, then by name — used by both layouts' friends list.
  const acceptedSorted = [...accepted].sort((a, b) => (Number(b.online) - Number(a.online)) || a.user.username.localeCompare(b.user.username));

  // Friend activity feed (recent real-money wins) — shared by both layouts.
  const feedBlock = feed.length > 0 ? (
    <div>
      <h2 className="font-display font-semibold tracking-wide text-gold-hi text-sm mb-2">{t('friends.feedTitle')}</h2>
      <ul className="space-y-1.5">
        {feed.slice(0, 8).map((e, i) => (
          <li key={`${e.userId}-${e.at}-${i}`} className="flex items-center gap-2 text-sm">
            <span aria-hidden="true">🏆</span>
            <span className="text-txt truncate flex-1 min-w-0">{t('friends.feedWin', { name: e.username, amount: dollars(e.amountCents) })}</span>
            <span className="text-[11px] text-muted/60 shrink-0">{relTime(e.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  // Duel: challenge a friend to a private FREE 1v1 — create the room (which seats me + navigates
  // to the waiting room) then fire the existing room invite to them. Online friends only.
  const duel = async (friend: FriendEntry) => {
    const gs = useGameStore.getState();
    const roomId = await gs.createRoom('1v1', 0, undefined, true);
    if (roomId) await gs.inviteFriend(friend.user.id);
  };

  // Shared send-money modal (also rendered inside the landscape portal so it overlays the console).
  const sendMoneyModal = sendTo && (
    <div className="modal-backdrop" onClick={() => { if (!sending) setSendTo(null); }} role="dialog" aria-modal="true" aria-label={t('friends.sendMoney')}>
      <div className="panel-solid w-full max-w-sm p-5 animate-pop space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('friends.sendTitle', { name: sendTo.user.username })}</h3>
        <p className="text-xs text-muted">{t('friends.yourBalance', { amount: dollars(balanceCents) })}</p>
        <label className="block">
          <span className="field-label">{t('friends.amount')}</span>
          <input className="field" type="number" inputMode="decimal" min="1" step="0.01" placeholder="0.00" value={amount}
            onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendMoney(); }} autoFocus />
        </label>
        <div className="flex gap-3 justify-end">
          <button className="btn btn-ghost" onClick={() => setSendTo(null)} disabled={sending}>{t('common.cancel')}</button>
          <button className="btn btn-gold" onClick={() => void sendMoney()} disabled={sending || !amount.trim()}>{sending ? t('friends.sending') : t('friends.send')}</button>
        </div>
      </div>
    </div>
  );

  // Shared search-results dropdown for the add-friend input (both layouts). Shows a small
  // list of matches (avatar + name + level), each with an "Add" button (sends a request),
  // plus searching / no-results states. The friends list already excludes existing friends
  // by relationship — duplicate requests are handled server-side, so we show all matches.
  const searchResults = username.trim().length >= 2 && (
    <div className="rounded-lg border border-white/10 bg-white/[.03] overflow-hidden">
      {searching ? (
        <p className="text-xs text-muted px-3 py-2">{t('friends.searching')}</p>
      ) : results.length === 0 ? (
        searched ? <p className="text-xs text-muted px-3 py-2">{t('friends.searchNoResults')}</p> : null
      ) : (
        <ul className="max-h-56 overflow-y-auto divide-y divide-white/5">
          {results.map((u) => (
            <li key={u.id} className="flex items-center gap-2 px-3 py-2">
              <span className="pfp shrink-0" style={{ width: 28, height: 28 }}><AvatarFace id={u.avatar} fill className="text-sm leading-none" /></span>
              <span className="min-w-0 flex-1">
                <span className="block font-display font-semibold text-txt text-sm truncate">{u.username}</span>
                <span className="block text-[11px] text-muted">{t('friends.level', { n: u.level })}</span>
              </span>
              <button onClick={() => void addByUsername(u.username)} disabled={busy} className="btn btn-gold btn-sm shrink-0">{t('friends.add')}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  // ---- Landscape "console": LEFT = add-friend + requests + friends list (tap to select);
  // RIGHT = the selected friend's actions. Portaled to <body> to escape the ViewTransition transform.
  if (landscape) {
    const selected = accepted.find((f) => f.user.id === selectedId) ?? null;
    return createPortal(
      <div className="pg-ls">
        {dialog}
        {sendMoneyModal}
        <div className="pg-ls-top">
          <button onClick={() => setView('lobby')} className="btn btn-ghost btn-sm">← {t('common.backToLobby')}</button>
          <h1 className="pg-ls-title gold-text font-display font-bold tracking-wide truncate">{t('friends.title')}</h1>
          <span className="text-sm font-display font-semibold text-gold-hi shrink-0">{dollars(balanceCents)}</span>
        </div>

        <div className="pg-ls-body">
          {/* LEFT — add friend + incoming requests + friends list */}
          <div className="pg-ls-left panel p-3">
            <div className="flex gap-2 items-center mb-2">
              <input className="field flex-1 min-w-0" placeholder={t('friends.searchPlaceholder')} value={username}
                onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addFriend(); }} aria-label={t('friends.addFriend')} />
              <button onClick={() => void addFriend()} disabled={busy || !username.trim()} className="btn btn-gold btn-sm shrink-0">{busy ? t('friends.sending') : t('friends.add')}</button>
            </div>
            {searchResults && <div className="mb-2">{searchResults}</div>}
            {incoming.length > 0 && (
              <details className="mb-2 rounded-lg border border-gold/30 bg-gold/[.05] px-2.5 py-1.5">
                <summary className="cursor-pointer text-xs font-display font-semibold text-gold-hi">{t('friends.requests')} ({incoming.length})</summary>
                <ul className="mt-2 space-y-1.5">
                  {incoming.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 border border-white/10 bg-white/[.03]">
                      <span className="font-display font-semibold text-txt text-sm flex-1 truncate">{f.user.username}</span>
                      <button onClick={() => void respond(f.id, true)} disabled={acting} className="btn btn-green btn-sm">{t('friends.accept')}</button>
                      <button onClick={() => void respond(f.id, false)} disabled={acting} className="btn btn-ghost btn-sm">{t('friends.decline')}</button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {loading ? (
              <div className="pg-ls-scroll pr-1"><SkeletonList count={5} /></div>
            ) : acceptedSorted.length === 0 ? (
              <div className="pg-ls-scroll text-center py-6">
                <div className="text-3xl mb-1 opacity-60">🫂</div>
                <p className="text-xs text-muted">{t('friends.empty')}</p>
              </div>
            ) : (
              <ul className="pg-ls-scroll space-y-1.5 pr-1">
                {acceptedSorted.map((f) => (
                  <li key={f.id}>
                    <button
                      onClick={() => setSelectedId(f.user.id)}
                      aria-current={selectedId === f.user.id ? 'true' : undefined}
                      className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 border text-left ${selectedId === f.user.id ? 'border-gold bg-gold/[.10]' : 'border-white/10 bg-white/[.03]'}`}
                    >
                      <span className="pfp shrink-0" style={{ width: 28, height: 28 }}><AvatarFace id={f.user.avatar} fill className="text-sm leading-none" /></span>
                      <span className="font-display font-semibold text-txt text-sm flex-1 truncate">{f.user.username}</span>
                      <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${presenceDot(f)}`} title={presenceText(f, t)} aria-label={presenceText(f, t)} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* RIGHT — selected friend's actions */}
          <div className="pg-ls-right pg-ls-scroll panel p-3">
            {!selected ? (
              feedBlock ? (
                <div className="space-y-3">
                  {feedBlock}
                  <p className="text-xs text-muted/70 text-center pt-1">{t('friends.selectPrompt')}</p>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center text-muted">
                  <div className="text-3xl mb-2 opacity-60">👈</div>
                  <p className="text-sm">{t('friends.selectPrompt')}</p>
                </div>
              )
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="pfp shrink-0" style={{ width: 44, height: 44 }}><AvatarFace id={selected.user.avatar} fill className="text-xl leading-none" /></span>
                  <div className="min-w-0">
                    <div className="font-display font-semibold tracking-wide text-txt truncate">{selected.user.username}</div>
                    <div className="text-xs text-muted">{t('friends.level', { n: selected.user.level })} · {presenceText(selected, t)}</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {inRoom && (
                    <button onClick={() => void useGameStore.getState().inviteFriend(selected.user.id)} disabled={acting} className="btn btn-gold">{t('friends.invite')}</button>
                  )}
                  {!inRoom && selected.online && (
                    <button onClick={() => void duel(selected)} disabled={acting} className="btn btn-gold">⚔️ {t('friends.duel')}</button>
                  )}
                  <button onClick={() => { setSendTo(selected); setAmount(''); }} disabled={acting} className="btn btn-ghost">💸 {t('friends.sendMoney')}</button>
                  <button onClick={() => { void remove(selected.id); setSelectedId(null); }} disabled={acting} className="btn btn-ghost">{t('common.remove')}</button>
                  <button onClick={() => { void block(selected.user.id); setSelectedId(null); }} disabled={acting} className="btn btn-ghost">{t('friends.block')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
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
      {dialog}

      {/* Send-money-to-a-friend modal */}
      {sendTo && (
        <div className="modal-backdrop" onClick={() => { if (!sending) setSendTo(null); }} role="dialog" aria-modal="true" aria-label={t('friends.sendMoney')}>
          <div className="panel-solid w-full max-w-sm p-5 animate-pop space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('friends.sendTitle', { name: sendTo.user.username })}</h3>
            <p className="text-xs text-muted">{t('friends.yourBalance', { amount: dollars(balanceCents) })}</p>
            <label className="block">
              <span className="field-label">{t('friends.amount')}</span>
              <input
                className="field"
                type="number"
                inputMode="decimal"
                min="1"
                step="0.01"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void sendMoney(); }}
                autoFocus
              />
            </label>
            <div className="flex gap-3 justify-end">
              <button className="btn btn-ghost" onClick={() => setSendTo(null)} disabled={sending}>{t('common.cancel')}</button>
              <button className="btn btn-gold" onClick={() => void sendMoney()} disabled={sending || !amount.trim()}>
                {sending ? t('friends.sending') : t('friends.send')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <section className="panel p-5 animate-rise">
        <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('friends.social')}</div>
        <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('friends.title')}</h1>
      </section>

      {/* Friends' recent activity (wins) */}
      {feedBlock && (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.04s' }}>{feedBlock}</section>
      )}

      {/* Add friend — search by username (debounced) or type a full name + Enter */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.08s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('friends.addFriend')}</h2>
        <div className="flex gap-3 items-end">
          <label className="flex-1">
            <span className="field-label">{t('friends.searchLabel')}</span>
            <input
              className="field"
              placeholder={t('friends.searchPlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addFriend(); }}
            />
          </label>
          <button onClick={() => void addFriend()} disabled={busy || !username.trim()} className="btn btn-gold">
            {busy ? t('friends.sending') : t('friends.add')}
          </button>
        </div>
        {searchResults}
      </section>

      {loading ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
          <SkeletonList count={5} />
        </section>
      ) : (
        <>
          {/* Incoming requests */}
          {incoming.length > 0 && (
            <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('friends.requests')} <span className="text-muted font-normal">({incoming.length})</span></h2>
              <ul className="space-y-2.5">
                {incoming.map((f) => (
                  <FriendRow key={f.id} entry={f}>
                    <button onClick={() => void respond(f.id, true)} disabled={acting} className="btn btn-green">{t('friends.accept')}</button>
                    <button onClick={() => void respond(f.id, false)} disabled={acting} className="btn btn-ghost">{t('friends.decline')}</button>
                    <button onClick={() => void block(f.user.id)} disabled={acting} className="btn btn-ghost" title={t('friends.block')}>{t('friends.block')}</button>
                  </FriendRow>
                ))}
              </ul>
            </section>
          )}

          {/* Outgoing / pending */}
          {outgoing.length > 0 && (
            <section className="panel p-5 animate-rise" style={{ animationDelay: '.16s' }}>
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('friends.pending')} <span className="text-muted font-normal">({outgoing.length})</span></h2>
              <ul className="space-y-2.5">
                {outgoing.map((f) => (
                  <FriendRow key={f.id} entry={f}>
                    <span className="tag tag-open">{t('friends.sent')}</span>
                    <button onClick={() => void remove(f.id)} disabled={acting} className="btn btn-ghost btn-sm" title={t('friends.cancelRequest')}>{t('friends.cancelRequest')}</button>
                  </FriendRow>
                ))}
              </ul>
            </section>
          )}

          {/* Friends */}
          <section className="panel p-5 animate-rise" style={{ animationDelay: '.2s' }}>
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('friends.friendsSection')} <span className="text-muted font-normal">({accepted.length})</span></h2>
            {accepted.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-4xl mb-2 opacity-60">🫂</div>
                <p className="text-sm text-muted">{t('friends.empty')}</p>
                <p className="text-xs text-muted/70 mt-1">{t('friends.emptyHint')}</p>
              </div>
            ) : (
              <ul className="grid gap-2.5 lg:grid-cols-2">
                {accepted.map((f) => (
                  <FriendRow key={f.id} entry={f} showOnline>
                    {inRoom && (
                      <button onClick={() => void useGameStore.getState().inviteFriend(f.user.id)} disabled={acting} className="btn btn-gold">
                        {t('friends.invite')}
                      </button>
                    )}
                    {!inRoom && f.online && (
                      <button onClick={() => void duel(f)} disabled={acting} className="btn btn-gold" title={t('friends.duelHint')}>
                        ⚔️ {t('friends.duel')}
                      </button>
                    )}
                    {inClub && (
                      <button onClick={() => void useGameStore.getState().inviteToClub(f.user.id)} disabled={acting} className="btn btn-ghost" title={t('clubs.inviteFriend')}>
                        🛡️ {t('clubs.inviteToClub')}
                      </button>
                    )}
                    <button onClick={() => { setSendTo(f); setAmount(''); }} disabled={acting} className="btn btn-ghost" title={t('friends.sendMoney')}>💸 {t('friends.sendMoney')}</button>
                    <button onClick={() => void remove(f.id)} disabled={acting} className="btn btn-ghost">{t('common.remove')}</button>
                    <button onClick={() => void block(f.user.id)} disabled={acting} className="btn btn-ghost" title={t('friends.block')}>{t('friends.block')}</button>
                  </FriendRow>
                ))}
              </ul>
            )}
          </section>

          {/* Blocked */}
          {blocked.length > 0 && (
            <section className="panel p-5 animate-rise" style={{ animationDelay: '.24s' }}>
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('friends.blocked')} <span className="text-muted font-normal">({blocked.length})</span></h2>
              <ul className="space-y-2.5">
                {blocked.map((f) => (
                  <FriendRow key={f.id} entry={f}>
                    <button onClick={() => void unblock(f.user.id)} disabled={acting} className="btn btn-ghost">{t('friends.unblock')}</button>
                  </FriendRow>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

interface FriendRowProps {
  entry: FriendEntry;
  showOnline?: boolean;
  children?: React.ReactNode;
}

function FriendRow({ entry, showOnline = false, children }: FriendRowProps) {
  const t = useT();
  const { user, online } = entry;
  return (
    <li className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold/40 transition-colors">
      <AvatarFace id={user.avatar} size={40} className="text-3xl leading-none" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {showOnline && (
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${presenceDot(entry)}`}
              title={presenceText(entry, t)}
              aria-label={presenceText(entry, t)}
            />
          )}
          <span className="font-display font-semibold tracking-wide text-txt truncate">{user.username}</span>
        </div>
        <div className="text-xs text-muted">{t('friends.level', { n: user.level })}{showOnline && online ? ` · ${presenceText(entry, t)}` : ''}</div>
      </div>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </li>
  );
}
