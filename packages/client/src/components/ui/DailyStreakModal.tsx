import { useEffect, useState } from 'react';
import { Modal } from './Modal.tsx';
import { rewardsApi } from '../../lib/api.ts';
import { useAuthStore } from '../../store/authStore.ts';
import { useGameStore } from '../../store/gameStore.ts';
import { useNotifications } from '../../store/notificationsStore.ts';
import { useT } from '../../lib/i18n.ts';
import { sound } from '../../lib/sound.ts';
import { haptics } from '../../lib/haptics.ts';

/**
 * Daily-streak claim POP-UP. On app open it checks the daily reward; if it's claimable it pops up once.
 * Claiming (or closing) hides it for the session, and — because the server flips `canClaim` to false after
 * a claim — it won't reappear until the streak resets the NEXT day (canClaim true again at UTC midnight).
 */
export function DailyStreakModal() {
  const t = useT();
  const [daily, setDaily] = useState<{ streak: number; canClaim: boolean; rewardXp: number } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    void rewardsApi.status(token).then((r) => setDaily(r.status.daily)).catch(() => {});
  }, []);

  if (dismissed || !daily?.canClaim) return null;

  const claim = async () => {
    if (claiming) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    setClaiming(true);
    sound.play('coin');
    haptics.win();
    try {
      const { rewardXp } = await rewardsApi.claimDaily(token);
      useNotifications.getState().push(t('rewards.dailyClaimed', { xp: rewardXp }), 'info');
      useGameStore.setState((s) => ({ rewardRev: (s.rewardRev ?? 0) + 1 })); // refresh Rewards view etc.
    } catch {
      /* best-effort — don't trap the user on the pop-up */
    } finally {
      setClaiming(false);
      setDismissed(true);
    }
  };

  return (
    <Modal title={t('streak.title')} onClose={() => setDismissed(true)} maxWidth={360}>
      <div className="text-center space-y-4">
        <div className="text-6xl" aria-hidden>🔥</div>
        <div>
          <div className="gold-text font-display font-bold text-3xl leading-tight">{t('rewards.streakDays', { n: daily.streak })}</div>
          <div className="text-sm text-muted mt-1">{t('streak.reward', { xp: daily.rewardXp })}</div>
        </div>
        <button type="button" onClick={() => void claim()} disabled={claiming} className="btn btn-gold btn-block">
          {claiming ? t('rewards.claiming') : t('streak.claim')}
        </button>
      </div>
    </Modal>
  );
}
