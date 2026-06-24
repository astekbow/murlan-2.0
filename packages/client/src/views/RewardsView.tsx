import { useCallback, useEffect, useRef, useState } from 'react';
import { rewardsApi, ApiError } from '../lib/api.ts';
import type { RewardsStatus, RewardChallenge } from '../lib/api.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { useNotifications } from '../store/notificationsStore.ts';
import { SkeletonList } from '../components/ui/Skeleton.tsx';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

// For use OUTSIDE render (callbacks/effects) — reads the live lang without making
// the translator a reactive dependency (a reactive t would recreate callbacks).
const tr = (key: string) => translate(key, useLangStore.getState().lang);

export function RewardsView() {
  const t = useT();
  const setView = useUiStore((s) => s.setView);

  const [status, setStatus] = useState<RewardsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = useAuthStore.getState().accessToken;
    if (!token) {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const { status } = await rewardsApi.status(token);
      setStatus(status);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : tr('rewards.errLoad'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live refresh: a finished match updated my stats (XP/wins/streak) → reload so
  // challenge progress + newly-claimable rewards appear without a manual refresh.
  // Skip while a claim is in flight so a stale refetch can't clobber the optimistic
  // post-claim state (the claim path reloads itself on completion).
  const rewardRev = useGameStore((s) => s.rewardRev);
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = busy !== null; }, [busy]);
  useEffect(() => {
    if (rewardRev > 0 && !busyRef.current) void load();
  }, [rewardRev, load]);

  const claimDaily = async () => {
    if (busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy('daily');
    try {
      const { rewardXp } = await rewardsApi.claimDaily(token);
      await load();
      await useAuthStore.getState().refreshMe();
      useNotifications.getState().push(t('rewards.dailyClaimed', { xp: rewardXp }), 'info');
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('rewards.errClaim'), toastKind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const claimChallenge = async (id: string) => {
    if (busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy(id);
    try {
      const { rewardXp } = await rewardsApi.claimChallenge(token, id);
      await load();
      await useAuthStore.getState().refreshMe();
      useNotifications.getState().push(t('rewards.challengeClaimed', { xp: rewardXp }), 'info');
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('rewards.errClaim'), toastKind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const claimAll = async () => {
    if (busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token || !status) return;
    const claimable = status.challenges.filter((c) => c.done && !c.claimed);
    if (claimable.length === 0) return;
    setBusy('all');
    try {
      // Claim each sequentially; ignore individual races (a concurrent claim) — the
      // reload reflects the true state.
      for (const c of claimable) await rewardsApi.claimChallenge(token, c.id).catch(() => undefined);
      await load();
      await useAuthStore.getState().refreshMe();
      useNotifications.getState().push(t('rewards.allClaimed'), 'info');
    } finally {
      setBusy(null);
    }
  };

  const claimableCount = status?.challenges.filter((c) => c.done && !c.claimed).length ?? 0;

  return (
    <div className="space-y-5">
      {/* Back to lobby */}
      <button onClick={() => setView('lobby')} className="btn btn-ghost">
        {t('common.backToLobby')}
      </button>

      {/* Title */}
      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('rewards.progress')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('rewards.title')}</h1>
        </div>
        <span className="text-4xl opacity-80" aria-hidden="true">🎁</span>
      </section>

      {loading ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
          <SkeletonList count={3} />
        </section>
      ) : error ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">⚠️</div>
            <p className="text-sm text-red-300">{error}</p>
          </div>
        </section>
      ) : !status ? null : status.enabled === false ? (
        <section className="panel p-5 animate-rise" style={{ animationDelay: '.08s' }}>
          <div className="text-center py-10">
            <div className="text-4xl mb-2 opacity-60">🚫</div>
            <p className="text-sm text-muted">{t('rewards.disabled')}</p>
          </div>
        </section>
      ) : (
        <>
          {/* Daily reward */}
          <section className="panel-solid p-6 animate-rise" style={{ animationDelay: '.08s' }}>
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('rewards.dailyTitle')}</h2>
              <span className="tag tag-open">🔥 {t('rewards.streakDays', { n: status.daily.streak })}</span>
            </div>

            <div className="flex items-center gap-3 mb-5">
              <span className="text-5xl leading-none" aria-hidden>📅</span>
              <div className="min-w-0">
                <div className="font-display font-bold text-2xl text-gold-hi leading-none">
                  +{status.daily.rewardXp} XP
                </div>
                <div className="text-xs text-muted mt-1">
                  {t('rewards.currentStreak', { n: status.daily.streak })} {status.daily.streak === 1 ? t('rewards.day') : t('rewards.days')}
                </div>
              </div>
            </div>

            {status.daily.canClaim ? (
              <button
                onClick={() => void claimDaily()}
                disabled={busy === 'daily'}
                className="btn btn-green btn-lg btn-block"
              >
                {busy === 'daily' ? t('rewards.claiming') : t('rewards.claimDaily', { xp: status.daily.rewardXp })}
              </button>
            ) : (
              <button disabled className="btn btn-ghost btn-lg btn-block">
                {t('rewards.claimedToday')}
              </button>
            )}
          </section>

          {/* Challenges */}
          <section className="panel p-5 animate-rise" style={{ animationDelay: '.12s' }}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('rewards.challenges')}</h2>
              {claimableCount > 1 ? (
                <button onClick={() => void claimAll()} disabled={!!busy} className="btn btn-gold btn-sm">
                  {busy === 'all' ? t('rewards.claiming') : t('rewards.claimAll', { n: claimableCount })}
                </button>
              ) : (
                <span className="text-xs text-muted">{t('rewards.challengesHint')}</span>
              )}
            </div>

            {status.challenges.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-4xl mb-2 opacity-60">🎯</div>
                <p className="text-sm text-muted">{t('rewards.noChallenges')}</p>
                <p className="text-xs text-muted/70 mt-1">{t('rewards.noChallengesHint')}</p>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {status.challenges.map((c, i) => (
                  <ChallengeRow
                    key={c.id}
                    challenge={c}
                    busy={busy === c.id}
                    index={i}
                    onClaim={() => void claimChallenge(c.id)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

interface ChallengeRowProps {
  challenge: RewardChallenge;
  busy: boolean;
  index: number;
  onClaim: () => void;
}

function ChallengeRow({ challenge, busy, index, onClaim }: ChallengeRowProps) {
  const t = useT();
  const { title, goal, progress, done, claimed, rewardXp } = challenge;
  const pct = goal > 0 ? Math.min(100, Math.round((progress / goal) * 100)) : 0;

  return (
    <li
      className="rounded-xl px-4 py-3 border border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] animate-rise"
      style={{ animationDelay: `${index * 0.05}s` }}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-display font-semibold tracking-wide text-txt truncate">{title}</div>
          <div className="text-xs text-gold mt-0.5">+{rewardXp} XP</div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {claimed ? (
            <span className="tag tag-open">{t('rewards.claimedTag')}</span>
          ) : done ? (
            <button onClick={onClaim} disabled={busy} className="btn btn-gold">
              {busy ? t('rewards.claiming') : t('rewards.claim')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-2.5">
        <div className="xpbar flex-1" style={{ width: 'auto' }} role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={goal}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-display font-semibold tracking-wide text-muted whitespace-nowrap">
          {progress}/{goal}
        </span>
      </div>
    </li>
  );
}
