import type { RoomStateDTO } from '@murlan/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { friendsApi, ApiError, type FriendEntry } from '../lib/api.ts';
import { avatarEmoji } from '../lib/avatars.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { dollars } from '../lib/money.ts';
import { sound } from '../lib/sound.ts';

const CONTEXT: Record<RoomStateDTO['type'], string> = {
  '1v1': 'SOLO · 1V1',
  '1v1v1': '1V1V1',
  '2v2': '2 KUNDËR 2',
};

export function RoomView({ room }: { room: RoomStateDTO }) {
  const { mySeat, setReady, leaveRoom } = useGameStore();
  const meReady = mySeat !== null ? room.seats[mySeat]?.ready ?? false : false;
  const filled = room.seats.filter((s) => s.userId !== null).length;
  const allFilled = filled === room.seats.length;
  const allReady = allFilled && room.seats.every((s) => s.ready);
  const counting = room.countdownMs != null;
  // The server sends the countdown duration once when it starts; tick it down
  // locally off a captured deadline so the big number actually counts (it used to
  // freeze at its initial value the whole window).
  const deadlineRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!counting) { deadlineRef.current = null; return; }
    if (deadlineRef.current === null) deadlineRef.current = Date.now() + (room.countdownMs as number);
    const id = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [counting, room.countdownMs]);
  const secs = counting && deadlineRef.current !== null ? Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)) : 0;
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);
  const canAfford = room.stakeCents === 0 || balanceCents >= room.stakeCents;

  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(true);

  const loadFriends = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) {
      setFriends([]);
      setFriendsLoading(false);
      return;
    }
    try {
      const { friends } = await friendsApi.list(token);
      setFriends(friends.filter((f) => f.direction === 'friends'));
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : 'Ngarkimi i miqve dështoi.' });
    } finally {
      setFriendsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFriends();
    // Refresh the authoritative balance on entry so the "Pa fonde" gate reflects
    // any deposit made since login (escrow stays server-authoritative regardless).
    void useAuthStore.getState().refreshMe();
  }, [loadFriends]);

  return (
    <div className="space-y-5">
      <button onClick={() => void leaveRoom()} className="btn btn-ghost">← Kthehu te lobi</button>

      {/* Crest / matchmaking header */}
      <section className="panel-solid p-6 text-center animate-rise">
        <div className="crest gold-text text-3xl sm:text-4xl mb-2">MURLAN</div>
        <div className="inline-flex items-center gap-2">
          <span className="tag tag-open">{CONTEXT[room.type]}</span>
          <span className="chip" style={{ padding: '5px 12px 5px 7px', fontSize: 13 }}>
            <span className="coin" style={{ width: 16, height: 16 }} />
            {dollars(room.stakeCents)}
          </span>
          <span className="text-xs text-muted">deri në <b className="text-gold-hi">{room.target}</b></span>
        </div>
      </section>

      {/* Seats filling in */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">LOJTARËT</h2>
          <span className="text-xs text-muted">{filled}/{room.seats.length} ulëse</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {room.seats.map((s, i) => {
            const mine = s.seat === mySeat;
            const ring = s.team === 0 ? 'var(--blue)' : s.team === 1 ? 'var(--red)' : s.ready ? 'var(--green)' : 'var(--gold-line)';
            return (
              <div
                key={s.seat}
                className={`flex flex-col items-center gap-2 rounded-xl px-3 py-4 border animate-rise ${mine ? 'bg-gold/[.06] border-gold/40' : 'border-white/10 bg-white/[.02]'}`}
                style={{ animationDelay: `${i * 0.07}s` }}
              >
                <span
                  className="pfp"
                  style={{ width: 54, height: 54, borderColor: s.userId ? ring : 'rgba(255,255,255,.12)', opacity: s.userId ? 1 : 0.4 }}
                >
                  {s.username ? s.username.charAt(0).toUpperCase() : '…'}
                </span>
                {s.username ? (
                  <div className="text-center">
                    <div className="font-display font-semibold tracking-wide text-sm truncate max-w-[110px]">
                      {s.username}{mine && <span className="text-gold"> (ti)</span>}
                    </div>
                    {room.type === '2v2' && <div className="text-[11px] text-muted">Ekipi {(s.team ?? 0) + 1}</div>}
                  </div>
                ) : (
                  <div className="text-xs italic text-muted/70">Duke pritur…</div>
                )}
                {s.userId &&
                  (s.ready ? <span className="tag tag-open">Gati</span> : <span className="tag tag-live"><span className="pls" />Pa gati</span>)}
              </div>
            );
          })}
        </div>
      </section>

      {/* Invite friends */}
      <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">FTO MIQ</h2>
        {friendsLoading ? (
          <div className="text-center py-6">
            <div className="text-3xl mb-2 opacity-60 animate-pulse">👥</div>
            <p className="text-sm text-muted">Po ngarkohen miqtë…</p>
          </div>
        ) : friends.length === 0 ? (
          <div className="text-center py-6">
            <div className="text-3xl mb-2 opacity-60">🫂</div>
            <p className="text-sm text-muted">S'ke miq ende — shtoji te 👥 Miqtë.</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {friends.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]"
              >
                <span className="text-3xl leading-none" aria-hidden>{avatarEmoji(f.user.avatar)}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full ${f.online ? 'bg-emerald-400' : 'bg-white/25'}`}
                      title={f.online ? 'Online' : 'Offline'}
                      aria-label={f.online ? 'Online' : 'Offline'}
                    />
                    <span className="font-display font-semibold tracking-wide text-txt truncate">{f.user.username}</span>
                  </div>
                  <div className="text-xs text-muted">Niveli {f.user.level}</div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => void useGameStore.getState().inviteFriend(f.user.id)} className="btn btn-gold">
                    Fto
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Countdown + ready CTA */}
      <section className="panel-solid p-6 space-y-4 animate-rise text-center" style={{ animationDelay: '.16s' }}>
        {counting ? (
          <div>
            <div className="gold-text font-display font-bold text-6xl leading-none animate-pop" key={secs}>{secs}</div>
            <div className="text-sm text-muted mt-1">Loja fillon…</div>
          </div>
        ) : (
          <div className="text-sm text-muted min-h-5">
            {allReady ? 'Të gjithë gati — ndeshja po fillon…' : allFilled ? 'Duke pritur që të gjithë të jenë gati…' : 'Duke pritur lojtarë…'}
          </div>
        )}

        {!canAfford && !meReady && (
          <div className="text-sm text-suit">
            Bilanc i pamjaftueshëm për bastin ({dollars(room.stakeCents)}). Depozito te kuleta për të luajtur.
          </div>
        )}
        <button
          onClick={() => { sound.play('button'); void setReady(!meReady); }}
          disabled={!canAfford && !meReady}
          className={`btn btn-lg btn-block ${meReady ? 'btn-ghost' : 'btn-green'}`}
        >
          {meReady ? 'Anulo gatishmërinë' : !canAfford ? 'Pa fonde' : 'Jam gati'}
        </button>
      </section>
    </div>
  );
}
