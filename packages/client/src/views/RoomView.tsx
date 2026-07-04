import type { RoomStateDTO } from '@murlan/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { friendsApi, ApiError, type FriendEntry } from '../lib/api.ts';
import { useWakeLock } from '../lib/useWakeLock.ts';
import { AvatarFace } from '../components/ui/AvatarFace.tsx';
import { useAuthStore } from '../store/authStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { dollars } from '../lib/money.ts';
import { roomInviteLink } from '../lib/deepLink.ts';
import { sound } from '../lib/sound.ts';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

const tr = (key: string) => translate(key, useLangStore.getState().lang);

// Copy to clipboard and toast the REAL outcome — the old code toasted "copied ✓" unconditionally,
// so in an in-app WebView / non-secure context (no navigator.clipboard) or when writeText rejects,
// the user was told it copied when nothing was on the clipboard and couldn't share a paid private room.
async function copyWithToast(text: string, okKey: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    useGameStore.setState({ toast: tr(okKey), toastKind: 'success' });
  } catch {
    useGameStore.setState({ toast: tr('common.copyFailed'), toastKind: 'error' });
  }
}

// Maps the room type to a catalog key, resolved with t() at render time.
const CONTEXT: Record<RoomStateDTO['type'], string> = {
  '1v1': 'room.ctxSolo',
  '1v1v1': 'room.ctx1v1v1',
  '2v2': 'room.ctx2v2',
};

export function RoomView({ room }: { room: RoomStateDTO }) {
  // perf-4: per-field selectors, not a whole-store subscription (avoid re-rendering on unrelated updates).
  const mySeat = useGameStore((s) => s.mySeat);
  const setReady = useGameStore((s) => s.setReady);
  const leaveRoom = useGameStore((s) => s.leaveRoom);
  const t = useT();
  useWakeLock(true); // keep the screen awake in the waiting room too (not just at the table)
  const landscape = useLandscapePage();
  const meReady = mySeat !== null ? room.seats[mySeat]?.ready ?? false : false;
  // Occupancy is by username, not userId: a seat can be filled by a player whose id
  // we don't expose (fill-players on free tables have their userId redacted).
  const filled = room.seats.filter((s) => s.username !== null).length;
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
  // Friends we've already invited → the button flips to "✓ Invited" so the tap has a clear reaction.
  const [invited, setInvited] = useState<Set<string>>(new Set());

  const doInvite = useCallback(async (userId: string, username: string) => {
    if (invited.has(userId)) return;
    sound.play('button');
    const ok = await useGameStore.getState().inviteFriend(userId);
    if (ok) {
      setInvited((prev) => new Set(prev).add(userId));
      useGameStore.setState({ toast: translate('room.inviteSent', useLangStore.getState().lang, { name: username }), toastKind: 'success' });
    }
  }, [invited]);

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
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : tr('room.errLoadFriends') });
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

  // Crest / matchmaking header (portrait only — landscape puts this in the console top bar).
  const headerCrest = (
    <section className="panel-solid p-6 text-center animate-rise">
      <div className="crest gold-text text-3xl sm:text-4xl mb-2">MURLAN</div>
      <div className="inline-flex items-center gap-2">
        <span className="tag tag-open">{t(CONTEXT[room.type])}</span>
        <span className="chip" style={{ padding: '5px 12px 5px 7px', fontSize: 13 }}>
          <span className="coin" style={{ width: 16, height: 16 }} />
          {dollars(room.stakeCents)}
        </span>
        <span className="text-xs text-muted">{t('room.upTo')} <b className="text-gold-hi">{room.target}</b></span>
      </div>
    </section>
  );

  // Private room: the shareable join code (tap to copy) + a one-tap invite LINK.
  const privateCode = room.private && room.joinCode ? (
    <section className="panel p-4 text-center animate-rise" style={{ animationDelay: '.04s' }}>
      <div className="text-[11px] uppercase tracking-wider text-muted/70 mb-1">{t('room.shareCode')}</div>
      <button
        onClick={() => void copyWithToast(room.joinCode!, 'room.codeCopied')}
        className="font-mono text-3xl tracking-[0.35em] gold-text font-bold"
        aria-label={tr('common.copyCode')}
      >
        {room.joinCode}
      </button>
      <div className="mt-2">
        <button
          onClick={() => void copyWithToast(roomInviteLink(room.joinCode!), 'room.linkCopied')}
          className="btn btn-ghost btn-sm"
        >
          {t('room.copyInviteLink')}
        </button>
      </div>
      <p className="text-[11px] text-muted/70 mt-1">{t('room.shareCodeHint')}</p>
    </section>
  ) : null;

  // Seats filling in
  const seatsGrid = (
    <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('room.players')}</h2>
        <span className="text-xs text-muted">{t('room.seatsCount', { filled, total: room.seats.length })}</span>
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
                style={{ width: 54, height: 54, borderColor: s.username ? ring : 'rgba(255,255,255,.12)', opacity: s.username ? 1 : 0.4 }}
              >
                {s.username
                  ? (s.avatar ? <AvatarFace id={s.avatar} fill className="text-2xl leading-none" /> : s.username.charAt(0).toUpperCase())
                  : '…'}
              </span>
              {s.username ? (
                <div className="text-center">
                  <div className="font-display font-semibold tracking-wide text-sm truncate max-w-[110px]">
                    {s.username}{mine && <span className="text-gold"> {t('room.youParen')}</span>}
                  </div>
                  {room.type === '2v2' && <div className="text-[11px] text-muted">{t('room.team', { n: (s.team ?? 0) + 1 })}</div>}
                </div>
              ) : (
                <div className="text-xs italic text-muted/70">{t('room.waiting')}</div>
              )}
              {s.username &&
                (s.ready ? <span className="tag tag-open">{t('room.ready')}</span> : <span className="tag tag-live"><span className="pls" />{t('room.notReady')}</span>)}
            </div>
          );
        })}
      </div>
    </section>
  );

  // 2v2 SQUAD PICKER: two columns (Team 1 | Team 2) with their two slots each and a JOIN button on the
  // team I'm not on (if it has an open slot) — so players arrange their own squads instead of being
  // auto-split. Seats {0,2} = Team 1, {1,3} = Team 2 (mirrors the server's DEFAULT_TEAMS).
  const TEAM_SLOTS = [[0, 2], [1, 3]] as const;
  const myTeam = mySeat !== null ? room.seats[mySeat]?.team ?? null : null;
  const teamsEl = (
    <section className="panel p-4 animate-rise" style={{ animationDelay: '.08s' }}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('room.players')}</h2>
        <span className="text-xs text-muted">{t('room.seatsCount', { filled, total: room.seats.length })}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {([0, 1] as const).map((ti) => {
          const slots = TEAM_SLOTS[ti];
          const mine = myTeam === ti;
          const hasFree = slots.some((idx) => room.seats[idx]?.username == null);
          const color = ti === 0 ? 'var(--blue)' : 'var(--red)';
          return (
            <div key={ti} className={`rounded-xl border p-2.5 flex flex-col gap-2 ${mine ? 'border-gold/50 bg-gold/[.06]' : 'border-white/10 bg-white/[.02]'}`}>
              <div className="font-display font-bold uppercase tracking-wider text-xs text-center" style={{ color }}>
                {t('room.team', { n: ti + 1 })}
              </div>
              {slots.map((idx) => {
                const s = room.seats[idx];
                const meHere = idx === mySeat;
                return (
                  <div key={idx} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 border ${meHere ? 'border-gold/40 bg-gold/[.05]' : 'border-white/10 bg-white/[.03]'}`}>
                    <span className="pfp" style={{ width: 34, height: 34, borderColor: s?.username ? color : 'rgba(255,255,255,.12)', opacity: s?.username ? 1 : 0.4 }}>
                      {s?.username ? (s.avatar ? <AvatarFace id={s.avatar} fill className="text-lg leading-none" /> : s.username.charAt(0).toUpperCase()) : '…'}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[13px] font-display">
                      {s?.username ?? <span className="italic text-muted/60">{t('room.waiting')}</span>}
                      {meHere && <span className="text-gold"> {t('room.youParen')}</span>}
                    </span>
                    {s?.username && s.ready && <span className="tag tag-open text-[10px] py-0 shrink-0">{t('room.ready')}</span>}
                  </div>
                );
              })}
              {!mine && hasFree && !counting && !meReady && (
                <button
                  onClick={() => { sound.play('button'); void useGameStore.getState().switchTeam(ti); }}
                  className="btn btn-gold btn-sm btn-block mt-0.5"
                >
                  {t('room.joinTeam')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );

  // Invite friends
  const inviteList = (
    <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
      <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base mb-3">{t('room.inviteFriends')}</h2>
      {friendsLoading ? (
        <div className="text-center py-6">
          <div className="text-3xl mb-2 opacity-60 animate-pulse">👥</div>
          <p className="text-sm text-muted">{t('room.loadingFriends')}</p>
        </div>
      ) : friends.length === 0 ? (
        <div className="text-center py-6">
          <div className="text-3xl mb-2 opacity-60">🫂</div>
          <p className="text-sm text-muted">{t('room.noFriends')}</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {friends.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]"
            >
              <AvatarFace id={f.user.avatar} size={40} className="text-3xl leading-none" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${f.online ? 'bg-emerald-400' : 'bg-white/25'}`}
                    title={f.online ? t('room.online') : t('room.offline')}
                    aria-label={f.online ? t('room.online') : t('room.offline')}
                  />
                  <span className="font-display font-semibold tracking-wide text-txt truncate">{f.user.username}</span>
                </div>
                <div className="text-xs text-muted">{t('room.level', { n: f.user.level })}</div>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {invited.has(f.user.id) ? (
                  <span className="btn btn-ghost pointer-events-none text-emerald-300" aria-live="polite">✓ {t('room.invited')}</span>
                ) : (
                  <button onClick={() => void doInvite(f.user.id, f.user.username)} className="btn btn-gold">
                    {t('room.invite')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  // Countdown + ready CTA
  const readyCta = (
    <section className="panel-solid p-6 space-y-4 animate-rise text-center" style={{ animationDelay: '.16s' }}>
      {counting ? (
        <div>
          <div className="gold-text font-display font-bold text-6xl leading-none animate-pop" key={secs}>{secs}</div>
          <div className="text-sm text-muted mt-1">{t('room.gameStarting')}</div>
        </div>
      ) : (
        <div className="text-sm text-muted min-h-5">
          {allReady ? t('room.allReady') : allFilled ? t('room.waitingReady') : t('room.waitingPlayers')}
        </div>
      )}

      {!canAfford && !meReady && (
        <div className="text-sm text-suit">
          {t('room.insufficient', { amount: dollars(room.stakeCents) })}
        </div>
      )}
      <button
        onClick={() => { sound.play('button'); void setReady(!meReady); }}
        disabled={!canAfford && !meReady}
        className={`btn btn-lg btn-block ${meReady ? 'btn-ghost' : 'btn-green'}`}
      >
        {meReady ? t('room.cancelReady') : !canAfford ? t('room.noFunds') : t('room.imReady')}
      </button>
    </section>
  );

  // Landscape (flat phone): a fixed-height console that fits WITHOUT page scroll. Seats sit in a
  // single centred ROW up top (using the width), the status + ready CTA in the middle, and the
  // join code + invite list scroll underneath. Compact, table-like — not the cramped two-pane.
  if (landscape) {
    const lsSeats = (
      <div className="flex justify-center flex-wrap gap-2 shrink-0">
        {room.seats.map((s) => {
          const mine = s.seat === mySeat;
          const ring = s.team === 0 ? 'var(--blue)' : s.team === 1 ? 'var(--red)' : s.ready ? 'var(--green)' : 'var(--gold-line)';
          return (
            <div
              key={s.seat}
              className={`flex flex-col items-center gap-1 rounded-xl px-3 py-2 border ${mine ? 'bg-gold/[.06] border-gold/40' : 'border-white/10 bg-white/[.02]'}`}
            >
              <span className="pfp" style={{ width: 42, height: 42, borderColor: s.username ? ring : 'rgba(255,255,255,.12)', opacity: s.username ? 1 : 0.4 }}>
                {s.username ? (s.avatar ? <AvatarFace id={s.avatar} fill className="text-xl leading-none" /> : s.username.charAt(0).toUpperCase()) : '…'}
              </span>
              <div className="text-xs font-display font-semibold tracking-wide truncate max-w-[88px] text-center">
                {s.username ?? <span className="italic text-muted/70">{t('room.waiting')}</span>}
              </div>
              {s.username
                ? (s.ready ? <span className="tag tag-open text-[10px] py-0">{t('room.ready')}</span> : <span className="tag tag-live text-[10px] py-0"><span className="pls" />{t('room.notReady')}</span>)
                : <span className="text-[10px] text-muted/50">·</span>}
            </div>
          );
        })}
      </div>
    );
    // Compact, CLEAR invite list for landscape: a 2-column grid of friend chips (avatar + online
    // dot + name + a gold "Invite" button) — uses the width and reads as obviously tappable.
    const lsInvite = (
      <section className="panel p-3">
        <h2 className="font-display font-semibold tracking-wide text-gold-hi text-sm mb-2 flex items-center gap-1.5">
          <span aria-hidden="true">👥</span> {t('room.inviteFriends')}
        </h2>
        {friendsLoading ? (
          <p className="text-xs text-muted text-center py-3">{t('room.loadingFriends')}</p>
        ) : friends.length === 0 ? (
          <p className="text-xs text-muted text-center py-3">{t('room.noFriends')}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-1.5">
            {friends.map((f) => (
              <li key={f.id} className="flex items-center gap-2 rounded-lg pl-2 pr-1.5 py-1.5 border border-white/10 bg-white/[.03] min-w-0">
                <span className="relative shrink-0">
                  <AvatarFace id={f.user.avatar} size={28} className="text-lg leading-none" />
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-[#0b0a0e] ${f.online ? 'bg-emerald-400' : 'bg-white/25'}`}
                    aria-label={f.online ? t('room.online') : t('room.offline')}
                  />
                </span>
                <span className="font-display font-semibold text-xs text-txt truncate flex-1 min-w-0">{f.user.username}</span>
                {invited.has(f.user.id) ? (
                  <span className="btn btn-ghost btn-sm shrink-0 pointer-events-none text-emerald-300" aria-live="polite">✓ {t('room.invited')}</span>
                ) : (
                  <button onClick={() => void doInvite(f.user.id, f.user.username)} className="btn btn-gold btn-sm shrink-0">
                    {t('room.invite')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
    return createPortal(
      <div className="pg-ls">
        <div className="pg-ls-top">
          <button onClick={() => void leaveRoom()} className="btn btn-ghost btn-sm">{t('common.backToLobby')}</button>
          <h1 className="pg-ls-title gold-text font-display font-bold tracking-wide truncate">MURLAN</h1>
          <span className="inline-flex items-center gap-1.5 shrink-0">
            <span className="tag tag-open">{t(CONTEXT[room.type])}</span>
            <span className="chip" style={{ padding: '4px 10px 4px 6px', fontSize: 12 }}>
              <span className="coin" style={{ width: 14, height: 14 }} />{dollars(room.stakeCents)}
            </span>
          </span>
        </div>
        <div className="flex-1 min-h-0 flex flex-col gap-2.5">
          {room.type === '2v2' ? teamsEl : lsSeats}
          {/* Status + the ready CTA — the core action, always visible without scroll. */}
          <div className="shrink-0 text-center space-y-1.5">
            {counting ? (
              <div className="gold-text font-display font-bold text-4xl leading-none animate-pop" key={secs}>{secs}</div>
            ) : (
              <div className="text-xs text-muted">{allReady ? t('room.allReady') : allFilled ? t('room.waitingReady') : t('room.waitingPlayers')}</div>
            )}
            {!canAfford && !meReady && <div className="text-xs text-suit">{t('room.insufficient', { amount: dollars(room.stakeCents) })}</div>}
            <button
              onClick={() => { sound.play('button'); void setReady(!meReady); }}
              disabled={!canAfford && !meReady}
              className={`btn btn-block ${meReady ? 'btn-ghost' : 'btn-green'}`}
            >
              {meReady ? t('room.cancelReady') : !canAfford ? t('room.noFunds') : t('room.imReady')}
            </button>
          </div>
          {/* Join code + invite list — the only scrolling region. */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-0.5">
            {privateCode}
            {lsInvite}
          </div>
        </div>
      </div>,
      document.getElementById('root') ?? document.body,
    );
  }

  return (
    <div className="room-page space-y-5">
      <h1 className="sr-only">{t('room.title')}</h1>
      <button onClick={() => void leaveRoom()} className="btn btn-ghost">{t('common.backToLobby')}</button>
      {headerCrest}
      {privateCode}
      {room.type === '2v2' ? teamsEl : seatsGrid}
      {inviteList}
      {readyCta}
    </div>
  );
}
