import { useCallback, useEffect, useState } from 'react';
import { friendsApi, ApiError, type FriendEntry } from '../lib/api.ts';
import { avatarEmoji } from '../lib/avatars.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { useUiStore } from '../store/uiStore.ts';

export function FriendsView() {
  const setView = useUiStore((s) => s.setView);

  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

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
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : 'Ngarkimi i miqve dështoi.', toastKind: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll so presence dots and incoming/accepted requests stay fresh while the
    // page is open (they used to only update on a full remount).
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  const addFriend = async () => {
    const name = username.trim();
    if (!name || busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy(true);
    try {
      await friendsApi.request(token, name);
      setUsername('');
      useGameStore.setState({ toast: 'Kërkesa u dërgua.', toastKind: 'success' });
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : 'Dërgimi i kërkesës dështoi.', toastKind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const respond = async (id: string, accept: boolean) => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try {
      await friendsApi.respond(token, id, accept);
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : 'Veprimi dështoi.', toastKind: 'error' });
    }
  };

  const remove = async (id: string) => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try {
      await friendsApi.remove(token, id);
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : 'Heqja dështoi.', toastKind: 'error' });
    }
  };

  const block = async (userId: string) => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try {
      await friendsApi.block(token, userId);
      useGameStore.setState({ toast: 'Përdoruesi u bllokua.', toastKind: 'success' });
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : 'Bllokimi dështoi.', toastKind: 'error' });
    }
  };

  const unblock = async (userId: string) => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try {
      await friendsApi.unblock(token, userId);
      await load();
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : 'Zhbllokimi dështoi.', toastKind: 'error' });
    }
  };

  const incoming = friends.filter((f) => f.direction === 'incoming');
  const outgoing = friends.filter((f) => f.direction === 'outgoing');
  const accepted = friends.filter((f) => f.direction === 'friends');
  const blocked = friends.filter((f) => f.direction === 'blocked');

  const inRoom = useGameStore.getState().room !== null;

  return (
    <div className="space-y-5">
      {/* Back to lobby */}
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        ← Kthehu te lobi
      </button>

      {/* Header */}
      <section className="panel p-5 animate-rise">
        <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">SOCIALE</div>
        <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">MIQTË</h1>
      </section>

      {/* Add friend */}
      <section className="panel p-5 space-y-3 animate-rise" style={{ animationDelay: '.08s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">SHTO MIK</h2>
        <div className="flex gap-3 items-end">
          <label className="flex-1">
            <span className="field-label">Përdoruesi</span>
            <input
              className="field"
              placeholder="Përdoruesi"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addFriend(); }}
            />
          </label>
          <button onClick={() => void addFriend()} disabled={busy || !username.trim()} className="btn btn-gold">
            {busy ? 'Po dërgohet…' : 'Shto'}
          </button>
        </div>
      </section>

      {loading ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
          <div className="text-center py-8">
            <div className="text-4xl mb-2 opacity-60 animate-pulse">👥</div>
            <p className="text-sm text-muted">Po ngarkohen miqtë…</p>
          </div>
        </section>
      ) : (
        <>
          {/* Incoming requests */}
          {incoming.length > 0 && (
            <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">KËRKESA</h2>
              <ul className="space-y-2.5">
                {incoming.map((f) => (
                  <FriendRow key={f.id} entry={f}>
                    <button onClick={() => void respond(f.id, true)} className="btn btn-green">Prano</button>
                    <button onClick={() => void respond(f.id, false)} className="btn btn-ghost">Refuzo</button>
                    <button onClick={() => void block(f.user.id)} className="btn btn-ghost" title="Blloko">Blloko</button>
                  </FriendRow>
                ))}
              </ul>
            </section>
          )}

          {/* Outgoing / pending */}
          {outgoing.length > 0 && (
            <section className="panel p-5 animate-rise" style={{ animationDelay: '.16s' }}>
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">NË PRITJE</h2>
              <ul className="space-y-2.5">
                {outgoing.map((f) => (
                  <FriendRow key={f.id} entry={f}>
                    <span className="tag tag-open">Dërguar</span>
                  </FriendRow>
                ))}
              </ul>
            </section>
          )}

          {/* Friends */}
          <section className="panel p-5 animate-rise" style={{ animationDelay: '.2s' }}>
            <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">MIQTË</h2>
            {accepted.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-4xl mb-2 opacity-60">🫂</div>
                <p className="text-sm text-muted">Ende pa miq.</p>
                <p className="text-xs text-muted/70 mt-1">Shto dikë me emrin e tyre të përdoruesit lart!</p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {accepted.map((f) => (
                  <FriendRow key={f.id} entry={f} showOnline>
                    {inRoom && (
                      <button onClick={() => void useGameStore.getState().inviteFriend(f.user.id)} className="btn btn-gold">
                        Fto
                      </button>
                    )}
                    <button onClick={() => void remove(f.id)} className="btn btn-ghost">Hiq</button>
                    <button onClick={() => void block(f.user.id)} className="btn btn-ghost" title="Blloko">Blloko</button>
                  </FriendRow>
                ))}
              </ul>
            )}
          </section>

          {/* Blocked */}
          {blocked.length > 0 && (
            <section className="panel p-5 animate-rise" style={{ animationDelay: '.24s' }}>
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">BLLOKUAR</h2>
              <ul className="space-y-2.5">
                {blocked.map((f) => (
                  <FriendRow key={f.id} entry={f}>
                    <button onClick={() => void unblock(f.user.id)} className="btn btn-ghost">Zhblloko</button>
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
  const { user, online } = entry;
  return (
    <li className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]">
      <span className="text-3xl leading-none" aria-hidden>{avatarEmoji(user.avatar)}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {showOnline && (
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-white/25'}`}
              title={online ? 'Online' : 'Offline'}
              aria-label={online ? 'Online' : 'Offline'}
            />
          )}
          <span className="font-display font-semibold tracking-wide text-txt truncate">{user.username}</span>
        </div>
        <div className="text-xs text-muted">Niveli {user.level}</div>
      </div>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </li>
  );
}
