import { useCallback, useEffect, useRef, useState } from 'react';
import { friendsApi, walletApi, clubsApi, ApiError, type FriendEntry } from '../lib/api.ts';
import { AvatarFace } from '../components/ui/AvatarFace.tsx';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useWalletStore } from '../store/walletStore.ts';
import { dollars } from '../lib/money.ts';
import { SkeletonList } from '../components/ui/Skeleton.tsx';
import { useConfirm } from '../components/ui/useConfirm.tsx';
import { useT } from '../lib/i18n.ts';

export function FriendsView() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const setView = useUiStore((s) => s.setView);

  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
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

  const addFriend = async () => {
    const name = username.trim();
    if (!name || busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy(true);
    try {
      await friendsApi.request(token, name);
      setUsername('');
      useGameStore.setState({ toast: t('friends.requestSent'), toastKind: 'success' });
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('friends.errRequest'), toastKind: 'error' });
    } finally {
      setBusy(false);
    }
  };

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

      {/* Add friend */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.08s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('friends.addFriend')}</h2>
        <div className="flex gap-3 items-end">
          <label className="flex-1">
            <span className="field-label">{t('friends.username')}</span>
            <input
              className="field"
              placeholder={t('friends.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addFriend(); }}
            />
          </label>
          <button onClick={() => void addFriend()} disabled={busy || !username.trim()} className="btn btn-gold">
            {busy ? t('friends.sending') : t('friends.add')}
          </button>
        </div>
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
              className={`inline-block w-2.5 h-2.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-white/25'}`}
              title={online ? t('common.online') : t('common.offline')}
              aria-label={online ? t('common.online') : t('common.offline')}
            />
          )}
          <span className="font-display font-semibold tracking-wide text-txt truncate">{user.username}</span>
        </div>
        <div className="text-xs text-muted">{t('friends.level', { n: user.level })}</div>
      </div>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </li>
  );
}
