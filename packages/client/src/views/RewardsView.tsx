import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { rewardsApi, ApiError } from '../lib/api.ts';
import type { RewardsStatus, RewardChallenge, RewardAchievement } from '../lib/api.ts';
import { useAuthStore } from '../store/authStore.ts';
import { useUiStore } from '../store/uiStore.ts';
import { useGameStore } from '../store/gameStore.ts';
import { useNotifications } from '../store/notificationsStore.ts';
import { SkeletonList } from '../components/ui/Skeleton.tsx';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { dollars } from '../lib/money.ts';
import { useT, translate, useLangStore } from '../lib/i18n.ts';

// For use OUTSIDE render (callbacks/effects) — reads the live lang without making
// the translator a reactive dependency (a reactive t would recreate callbacks).
const tr = (key: string) => translate(key, useLangStore.getState().lang);

export function RewardsView() {
  const t = useT();
  const setView = useUiStore((s) => s.setView);
  const landscape = useLandscapePage();
  const balanceCents = useAuthStore((s) => s.user?.balanceCents ?? 0);

  const [status, setStatus] = useState<RewardsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rewardsTab, setRewardsTab] = useState<'daily' | 'quests' | 'challenges'>('daily'); // portrait tabs → no scroll

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

  const claimQuest = async (kind: 'daily' | 'weekly', id: string) => {
    if (busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy(`${kind}:${id}`);
    try {
      const { rewardXp } = kind === 'daily'
        ? await rewardsApi.claimDailyQuest(token, id)
        : await rewardsApi.claimWeeklyQuest(token, id);
      await load();
      await useAuthStore.getState().refreshMe();
      useNotifications.getState().push(t('rewards.questClaimed', { xp: rewardXp }), 'info');
    } catch (e) {
      useGameStore.setState({ toast: e instanceof ApiError ? e.message : t('rewards.errClaim'), toastKind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const claimLevelReward = async () => {
    if (busy) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setBusy('level');
    try {
      const r = await rewardsApi.claimLevelReward(token);
      await load();
      await useAuthStore.getState().refreshMe();
      const cos = r.cosmeticId ? t('rewards.plusCosmetic') : '';
      useNotifications.getState().push(t('rewards.levelRewardClaimed', { n: r.level, xp: r.bonusXp, cos }), 'info');
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

  // ---- Landscape "console": LEFT = daily-claim / streak summary; RIGHT = challenges list.
  // Portaled to <body> so it escapes the ViewTransition transform that would trap fixed.
  if (landscape) {
    return createPortal(
      <div className="pg-ls">
        <div className="pg-ls-top">
          <button onClick={() => setView('lobby')} className="btn btn-ghost btn-sm">← {t('common.backToLobby')}</button>
          <h1 className="pg-ls-title gold-text font-display font-bold tracking-wide truncate">{t('rewards.title')}</h1>
          <span className="text-sm font-display font-semibold text-gold-hi shrink-0">{dollars(balanceCents)}</span>
        </div>

        {loading ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4"><SkeletonList count={4} /></div></div>
        ) : error ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4 text-center"><div className="text-3xl mb-2 opacity-60">⚠️</div><p className="text-sm text-red-300">{error}</p></div></div>
        ) : !status ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4" /></div>
        ) : status.enabled === false ? (
          <div className="pg-ls-body"><div className="pg-ls-scroll panel p-4 text-center py-10"><div className="text-3xl mb-2 opacity-60">🚫</div><p className="text-sm text-muted">{t('rewards.disabled')}</p></div></div>
        ) : (
          <div className="pg-ls-body">
            {/* LEFT — daily reward + streak */}
            <div className="pg-ls-left panel-solid p-3">
              <div className="pg-ls-scroll pr-1 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-display font-semibold text-gold-hi">{t('rewards.dailyTitle')}</h2>
                  <span className="tag tag-open text-[11px]">🔥 {t('rewards.streakDays', { n: status.daily.streak })}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-4xl leading-none" aria-hidden>📅</span>
                  <div className="min-w-0">
                    <div className="font-display font-bold text-xl text-gold-hi leading-none">+{status.daily.rewardXp} XP</div>
                    <div className="text-xs text-muted mt-1">{t('rewards.currentStreak', { n: status.daily.streak })} {status.daily.streak === 1 ? t('rewards.day') : t('rewards.days')}</div>
                  </div>
                </div>
                {status.daily.canClaim ? (
                  <button onClick={() => void claimDaily()} disabled={busy === 'daily'} className="btn btn-green btn-block">
                    {busy === 'daily' ? t('rewards.claiming') : t('rewards.claimDaily', { xp: status.daily.rewardXp })}
                  </button>
                ) : (
                  <button disabled className="btn btn-ghost btn-block">{t('rewards.claimedToday')}</button>
                )}
              </div>
            </div>

            {/* RIGHT — level reward + rotating quests + challenges */}
            <div className="pg-ls-right">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <h2 className="text-sm font-display font-semibold text-gold-hi">{t('rewards.title')}</h2>
                {claimableCount > 1 && (
                  <button onClick={() => void claimAll()} disabled={!!busy} className="btn btn-gold btn-sm">
                    {busy === 'all' ? t('rewards.claiming') : t('rewards.claimAll', { n: claimableCount })}
                  </button>
                )}
              </div>
              <div className="pg-ls-scroll panel p-3 space-y-3">
                {status.levelReward && (
                  <div className="rounded-xl px-3 py-2.5 border border-gold/30 bg-white/[.03] flex items-center gap-3">
                    <span className="text-2xl leading-none" aria-hidden>🏆</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-display font-semibold text-sm text-gold-hi">{t('rewards.levelReached', { n: status.levelReward.level })}</div>
                      <div className="text-xs text-muted">+{status.levelReward.bonusXp} XP{status.levelReward.cosmeticId ? t('rewards.plusCosmetic') : ''}</div>
                    </div>
                    <button onClick={() => void claimLevelReward()} disabled={busy === 'level'} className="btn btn-gold btn-sm shrink-0">
                      {busy === 'level' ? t('rewards.claiming') : t('rewards.claim')}
                    </button>
                  </div>
                )}

                {status.dailyQuests.length > 0 && (
                  <div>
                    <h3 className="text-xs font-display font-semibold text-gold-hi mb-1.5">{t('rewards.dailyQuests')}</h3>
                    <ul className="space-y-2">
                      {status.dailyQuests.map((q, i) => (
                        <ChallengeRow key={q.id} challenge={q} busy={busy === `daily:${q.id}`} index={i} onClaim={() => void claimQuest('daily', q.id)} />
                      ))}
                    </ul>
                  </div>
                )}

                {status.weeklyQuests.length > 0 && (
                  <div>
                    <h3 className="text-xs font-display font-semibold text-gold-hi mb-1.5">{t('rewards.weeklyQuests')}</h3>
                    <ul className="space-y-2">
                      {status.weeklyQuests.map((q, i) => (
                        <ChallengeRow key={q.id} challenge={q} busy={busy === `weekly:${q.id}`} index={i} onClaim={() => void claimQuest('weekly', q.id)} />
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <h3 className="text-xs font-display font-semibold text-gold-hi mb-1.5">{t('rewards.challenges')}</h3>
                  {status.challenges.length === 0 ? (
                    <div className="text-center py-6"><div className="text-3xl mb-2 opacity-60">🎯</div><p className="text-sm text-muted">{t('rewards.noChallenges')}</p></div>
                  ) : (
                    <ul className="space-y-2">
                      {status.challenges.map((c, i) => (
                        <ChallengeRow key={c.id} challenge={c} busy={busy === c.id} index={i} onClaim={() => void claimChallenge(c.id)} />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
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

      {/* Title */}
      <section className="panel p-5 animate-rise flex items-center justify-between gap-4">
        <div>
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">{t('rewards.progress')}</div>
          <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('rewards.title')}</h1>
        </div>
        {/* Show spendable XP here too (not just in the Shop) — this is where you earn it. */}
        {status ? (
          <div className="text-right shrink-0">
            <div className="font-display font-bold text-xl text-gold-hi leading-none">{t('shop.xpBalance', { xp: status.spendableXp })}</div>
            <div className="text-[10px] text-muted mt-1 tracking-wide uppercase">{t('rewards.spendableXp')}</div>
          </div>
        ) : (
          <span className="text-4xl opacity-80" aria-hidden="true">🎁</span>
        )}
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
          {/* Tabs so each part fits the screen without scroll. */}
          <div className="seg grid grid-cols-3" role="tablist" aria-label={t('rewards.title')}>
            {(['daily', 'quests', 'challenges'] as const).map((tab) => (
              <button key={tab} type="button" role="tab" aria-selected={rewardsTab === tab} onClick={() => setRewardsTab(tab)} className={`seg-tab text-center ${rewardsTab === tab ? 'active' : ''}`}>
                {t(`rewards.tab.${tab}`)}
              </button>
            ))}
          </div>
          {/* Daily reward */}
          <section className={`panel-solid p-6 animate-rise ${rewardsTab === 'daily' ? '' : 'hidden'}`} style={{ animationDelay: '.08s' }}>
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

          {/* Level-up reward — shown only when one is pending (reached but uncollected) */}
          {status.levelReward && (
            <section className={`panel-solid p-5 animate-rise border border-gold/30 ${rewardsTab === 'daily' ? '' : 'hidden'}`} style={{ animationDelay: '.1s' }}>
              <div className="flex items-center gap-4">
                <span className="text-4xl leading-none" aria-hidden>🏆</span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('rewards.levelRewardTitle')}</h2>
                  <div className="text-sm text-txt mt-0.5">{t('rewards.levelReached', { n: status.levelReward.level })}</div>
                  <div className="text-xs text-muted mt-0.5">
                    +{status.levelReward.bonusXp} XP{status.levelReward.cosmeticId ? t('rewards.plusCosmetic') : ''} — {t('rewards.levelRewardBody')}
                  </div>
                </div>
              </div>
              <button onClick={() => void claimLevelReward()} disabled={busy === 'level'} className="btn btn-gold btn-block mt-4">
                {busy === 'level' ? t('rewards.claiming') : t('rewards.claimLevelReward')}
              </button>
            </section>
          )}

          {/* Daily quests (rotate every UTC day) */}
          <section className={`panel p-5 animate-rise ${rewardsTab === 'quests' ? '' : 'hidden'}`} style={{ animationDelay: '.11s' }}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('rewards.dailyQuests')}</h2>
              <span className="text-xs text-muted">{t('rewards.dailyQuestsHint')}</span>
            </div>
            {status.dailyQuests.length === 0 ? (
              <div className="text-center py-6"><div className="text-3xl mb-2 opacity-60">📆</div><p className="text-sm text-muted">{t('rewards.noDailyQuests')}</p></div>
            ) : (
              <ul className="space-y-2.5">
                {status.dailyQuests.map((q, i) => (
                  <ChallengeRow key={q.id} challenge={q} busy={busy === `daily:${q.id}`} index={i} onClaim={() => void claimQuest('daily', q.id)} />
                ))}
              </ul>
            )}
          </section>

          {/* Weekly quests (rotate every ISO week) */}
          <section className={`panel p-5 animate-rise ${rewardsTab === 'quests' ? '' : 'hidden'}`} style={{ animationDelay: '.115s' }}>
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('rewards.weeklyQuests')}</h2>
              <span className="text-xs text-muted">{t('rewards.weeklyQuestsHint')}</span>
            </div>
            {status.weeklyQuests.length === 0 ? (
              <div className="text-center py-6"><div className="text-3xl mb-2 opacity-60">🗓️</div><p className="text-sm text-muted">{t('rewards.noWeeklyQuests')}</p></div>
            ) : (
              <ul className="space-y-2.5">
                {status.weeklyQuests.map((q, i) => (
                  <ChallengeRow key={q.id} challenge={q} busy={busy === `weekly:${q.id}`} index={i} onClaim={() => void claimQuest('weekly', q.id)} />
                ))}
              </ul>
            )}
          </section>

          {/* Challenges */}
          <section className={`panel p-5 animate-rise ${rewardsTab === 'challenges' ? '' : 'hidden'}`} style={{ animationDelay: '.12s' }}>
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

          {/* Achievements / badges ("Arritjet") */}
          {status.achievements.length > 0 && (
            <section className={`panel p-5 animate-rise ${rewardsTab === 'challenges' ? '' : 'hidden'}`} style={{ animationDelay: '.16s' }}>
              <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{t('rewards.achievements')}</h2>
                <span className="text-xs text-muted">
                  {t('rewards.achEarnedCount', { n: status.achievements.filter((a) => a.earned).length, total: status.achievements.length })}
                </span>
              </div>
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {status.achievements.map((a, i) => (
                  <AchievementRow key={a.id} achievement={a} index={i} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

interface AchievementRowProps {
  achievement: RewardAchievement;
  index: number;
}

function AchievementRow({ achievement, index }: AchievementRowProps) {
  const t = useT();
  const { title, desc, icon, goal, progress, earned } = achievement;
  const pct = goal > 0 ? Math.min(100, Math.round((progress / goal) * 100)) : 0;

  return (
    <li
      title={desc}
      className={`rounded-xl px-4 py-3 border animate-rise ${
        earned
          ? 'border-gold/40 bg-gold/[.08]'
          : 'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]'
      }`}
      style={{ animationDelay: `${index * 0.04}s` }}
    >
      <div className="flex items-center gap-3">
        <span className={`text-2xl leading-none shrink-0 ${earned ? '' : 'opacity-30 grayscale'}`} aria-hidden>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className={`font-display font-semibold tracking-wide truncate ${earned ? 'text-gold-hi' : 'text-txt'}`}>{title}</div>
          <div className="text-xs text-muted mt-0.5 truncate">{desc}</div>
        </div>
        {earned ? (
          <span className="tag tag-open shrink-0">{t('rewards.achEarned')}</span>
        ) : (
          <span className="text-xs font-display font-semibold text-muted shrink-0 whitespace-nowrap">{progress}/{goal}</span>
        )}
      </div>
      {!earned && (
        <div className="xpbar mt-2.5" style={{ width: '100%' }} role="progressbar" aria-label={t('rewards.achProgressLabel', { title })} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={goal}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
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
