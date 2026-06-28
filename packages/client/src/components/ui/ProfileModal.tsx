// Profile modal — shows a player's avatar, level, XP bar and lifetime stats.
// For the signed-in user it also offers a preset-avatar picker. Read-only data
// is fetched via profileApi.get; avatar changes go through profileApi.setAvatar
// and then refresh both the local profile and the auth store.
import { useEffect, useState } from 'react';
import { Modal } from './Modal.tsx';
import { profileApi, rankedApi, friendsApi, ApiError, type Profile, type RankedProfileDTO } from '../../lib/api.ts';
import { avatarEmoji, isImageAvatar, imageToAvatarDataUrl, AVATARS } from '../../lib/avatars.ts';
import { dollars } from '../../lib/money.ts';
import { useAuthStore } from '../../store/authStore.ts';
import { TierBadge } from './TierBadge.tsx';
import { earnedBadges } from '../../lib/badges.ts';
import { useT } from '../../lib/i18n.ts';

interface ProfileModalProps {
  userId: string;
  onClose: () => void;
  /** Called after the signed-in user changes their avatar (so the top bar refreshes). */
  onProfileChange?: () => void;
}

export function ProfileModal({ userId, onClose, onProfileChange }: ProfileModalProps) {
  const t = useT();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ranked, setRanked] = useState<RankedProfileDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingAvatar, setSavingAvatar] = useState<string | null>(null);

  const isMe = userId === useAuthStore.getState().user?.id;
  const [friendMsg, setFriendMsg] = useState<string | null>(null);
  const [sendingFriend, setSendingFriend] = useState(false);

  // Send a friend request straight from a profile (e.g. tapped from an in-game seat).
  async function sendFriendReq() {
    const token = useAuthStore.getState().accessToken;
    if (!token || !profile || sendingFriend) return;
    setSendingFriend(true);
    try {
      await friendsApi.request(token, profile.username);
      setFriendMsg(t('friends.requestSent'));
    } catch (e) {
      setFriendMsg(e instanceof ApiError ? e.message : t('profile.loadFailed'));
    } finally {
      setSendingFriend(false);
    }
  }

  async function load() {
    try {
      const { profile: p } = await profileApi.get(userId);
      setProfile(p);
      setError(null);
      // Ranked standing is only exposed for the signed-in user (/ranked/me).
      const token = useAuthStore.getState().accessToken;
      if (isMe && token) {
        rankedApi.me(token).then(({ ranked }) => setRanked(ranked)).catch(() => setRanked(null));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('profile.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function pickAvatar(avatar: string) {
    if (savingAvatar) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setSavingAvatar(avatar);
    try {
      await profileApi.setAvatar(token, avatar);
      await load();
      await useAuthStore.getState().refreshMe();
      onProfileChange?.(); // refresh the top-bar avatar immediately
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('profile.avatarSaveFailed'));
    } finally {
      setSavingAvatar(null);
    }
  }

  /** Upload a custom photo: resize to a tiny square, then save it like any avatar. */
  async function uploadAvatar(file: File) {
    if (savingAvatar) return;
    try {
      const dataUrl = await imageToAvatarDataUrl(file, 64);
      if (dataUrl.length > 24_000) { setError(t('profile.avatarTooBig')); return; }
      await pickAvatar(dataUrl);
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      // A decode/format failure (e.g. an unreadable HEIC) gets a specific, actionable message.
      setError(code === 'avatar_unsupported' || code === 'avatar_decode'
        ? t('profile.avatarUnsupported')
        : t('profile.avatarSaveFailed'));
    }
  }

  return (
    <Modal title={t('profile.title')} onClose={onClose} maxWidth={460}>
      {loading ? (
        <div className="text-center py-10">
          <div className="text-4xl mb-2 opacity-60 animate-twinkle">🎴</div>
          <p className="text-sm text-muted">{t('profile.loading')}</p>
        </div>
      ) : error || !profile ? (
        <div className="text-center py-10">
          <div className="text-4xl mb-2 opacity-60">⚠️</div>
          <p className="text-sm text-red-300">{error ?? t('profile.notFound')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Identity: big avatar + level + XP */}
          <div className="flex items-center gap-4">
            <div
              className="pfp"
              style={{
                width: 72, height: 72, fontSize: 34,
                // VIP ring (bronze+): a coloured outline + soft glow around the photo.
                ...(profile.vipTier ? { boxShadow: `0 0 0 3px ${profile.vipTier.color}, 0 0 14px ${profile.vipTier.color}77` } : {}),
              }}
            >
              {isImageAvatar(profile.avatar) ? <img src={profile.avatar} alt="" className="pfp-img" /> : avatarEmoji(profile.avatar)}
              <span className="lvl">{profile.level}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-display font-semibold tracking-wide text-xl leading-none truncate flex items-center gap-2">
                <span className="truncate">{profile.username}</span>
                {profile.vipTier && (
                  <span
                    className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 whitespace-nowrap"
                    style={{ color: profile.vipTier.color, border: `1px solid ${profile.vipTier.color}`, background: `${profile.vipTier.color}1a` }}
                  >
                    ★ {profile.vipTier.name}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted mt-1">
                {t('profile.levelXp', { level: profile.level, xp: profile.xp })}
              </div>
              <div className="xpbar" style={{ width: '100%' }}>
                <i style={{ width: `${Math.round(profile.levelInfo.pct * 100)}%` }} />
              </div>
            </div>
          </div>

          {/* Add-friend — shown for everyone but yourself (e.g. tapped from an in-game seat). */}
          {!isMe && (
            <button
              className="btn btn-outline btn-sm w-full"
              onClick={sendFriendReq}
              disabled={sendingFriend || friendMsg === t('friends.requestSent')}
            >
              {friendMsg ?? `➕ ${t('friends.addFriend')}`}
            </button>
          )}

          {/* Earned badges (derived from stats) */}
          {earnedBadges(profile).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {earnedBadges(profile).map((b) => (
                <span
                  key={b.id}
                  title={b.desc}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/[.10] px-2.5 py-1 text-xs font-display font-semibold text-gold-hi"
                >
                  <span aria-hidden>{b.icon}</span>{b.name}
                </span>
              ))}
            </div>
          )}

          {/* Ranked standing (signed-in user only; shown when a season is active) */}
          {isMe && ranked?.season && (
            <div className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.05] to-white/[.01]">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="font-serif text-[10px] tracking-[0.25em] text-muted uppercase">
                  {t('profile.rankedSeason', { n: ranked.season.number })}
                </span>
                <TierBadge tier={ranked.tier} size="sm" />
              </div>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="font-display font-bold text-2xl text-gold-hi leading-none">{ranked.rating}</div>
                  <div className="text-[10px] text-muted mt-1">{t('profile.mmrPeak', { n: ranked.peakRating })}</div>
                </div>
                <div className="text-right text-xs text-muted">
                  {t('profile.winsGames', { wins: ranked.wins, games: ranked.games, pct: Math.round(ranked.winRate * 100) })}
                  {ranked.tier.next && (
                    <div className="text-[10px] text-muted/70 mt-0.5">
                      {t('profile.mmrToTier', { n: Math.max(0, ranked.tier.next.min - ranked.rating), tier: ranked.tier.next.name })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Lifetime stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label={t('profile.statGames')} value={String(profile.gamesPlayed)} />
            <StatCard label={t('profile.statWins')} value={String(profile.wins)} />
            <StatCard label={t('profile.statWinPct')} value={`${Math.round(profile.winRate * 100)}%`} />
            <StatCard label={t('profile.statStreak')} value={String(profile.currentStreak)} />
            <StatCard label={t('profile.statBiggestPot')} value={dollars(profile.biggestPotCents)} wide />
          </div>

          {/* Avatar picker (only for the signed-in user) */}
          {isMe && (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display font-semibold tracking-wide text-gold-hi text-sm">
                  {t('profile.chooseAvatar')}
                </h3>
                <label className={`btn btn-ghost btn-sm cursor-pointer ${savingAvatar ? 'opacity-50 pointer-events-none' : ''}`}>
                  📷 {t('profile.uploadAvatar')}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.target.value = ''; }}
                  />
                </label>
              </div>
              <div className="grid grid-cols-6 gap-2.5" role="radiogroup" aria-label={t('profile.chooseAvatar')}>
                {AVATARS.map((a) => {
                  const active = profile.avatar === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => void pickAvatar(a)}
                      disabled={savingAvatar !== null}
                      title={a}
                      className={`aspect-square rounded-xl grid place-items-center text-2xl transition-all border ${
                        active
                          ? 'border-gold bg-gold/[.12] shadow-[0_6px_16px_-6px_rgba(230,197,112,0.6)]'
                          : 'border-white/10 bg-white/[.03] hover:border-gold hover:-translate-y-0.5'
                      } ${savingAvatar === a ? 'opacity-50' : ''} disabled:cursor-not-allowed`}
                    >
                      {avatarEmoji(a)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-300">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function StatCard({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={`rounded-xl px-3 py-2.5 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] ${
        wide ? 'col-span-2 sm:col-span-1' : ''
      }`}
    >
      <div className="font-serif text-[10px] tracking-[0.2em] text-muted uppercase">{label}</div>
      <div className="font-display font-semibold tracking-wide text-gold-hi text-lg leading-tight mt-0.5">
        {value}
      </div>
    </div>
  );
}
