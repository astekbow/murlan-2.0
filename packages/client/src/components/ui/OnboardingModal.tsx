// First-run welcome wizard: a 3-step intro shown once to a new player — what
// Murlan is, a free practice game vs bots, then how real-money tables work. It
// leans on the existing practice mode (zero-stake) so a newcomer can learn the
// rules before risking money. Dismissal sticks via the onboarding store.
import { useState } from 'react';
import { Modal } from './Modal.tsx';
import { useOnboardingStore } from '../../store/onboardingStore.ts';
import { useRulesStore } from '../../store/rulesStore.ts';
import { useGameStore } from '../../store/gameStore.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';

const STEPS = [
  { icon: '🃏', titleKey: 'onb.s1Title', bodyKey: 'onb.s1Body' },
  { icon: '🤖', titleKey: 'onb.s2Title', bodyKey: 'onb.s2Body' },
  { icon: '💰', titleKey: 'onb.s3Title', bodyKey: 'onb.s3Body' },
] as const;

export function OnboardingModal() {
  const t = useT();
  const complete = useOnboardingStore((s) => s.complete);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const last = step === STEPS.length - 1;
  const s = STEPS[step];

  // "Try a practice game" — starts a zero-stake table vs easy bots, then closes.
  // The table view takes over from here; if it can't start we just finish the
  // wizard so the player isn't stuck on a dead button.
  const tryPractice = async () => {
    if (busy) return;
    setBusy(true);
    sound.play('button');
    try { await useGameStore.getState().startPractice('1v1', 'easy'); } catch { /* fall through */ }
    complete();
  };

  return (
    <Modal title={t('onb.title')} onClose={complete}>
      <div className="space-y-4 text-center">
        <div className="text-5xl">{s.icon}</div>
        <h3 className="font-display font-semibold text-gold-hi text-lg">{t(s.titleKey)}</h3>
        <p className="text-sm text-muted leading-relaxed">{t(s.bodyKey)}</p>

        {/* Step dots */}
        <div className="flex items-center justify-center gap-2 py-1" aria-hidden>
          {STEPS.map((_, i) => (
            <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-5 bg-gold' : 'w-1.5 bg-white/20'}`} />
          ))}
        </div>

        <div className="space-y-2">
          {/* On the practice step, offer the one-tap practice game. */}
          {step === 1 && (
            <button className="btn btn-green btn-lg btn-block" disabled={busy} onClick={() => void tryPractice()}>
              {busy ? t('onb.starting') : t('onb.tryPractice')}
            </button>
          )}
          {last ? (
            <button className="btn btn-gold btn-lg btn-block" onClick={complete}>{t('onb.done')}</button>
          ) : (
            <button className="btn btn-gold btn-lg btn-block" onClick={() => { sound.play('button'); setStep((n) => n + 1); }}>
              {t('onb.next')}
            </button>
          )}
          {step > 0 && (
            <button className="btn btn-ghost btn-block text-sm" onClick={() => { sound.play('button'); setStep((n) => Math.max(0, n - 1)); }}>{t('onb.back')}</button>
          )}
          <button className="btn btn-ghost btn-block text-sm" onClick={() => useRulesStore.getState().setOpen(true)}>{t('onb.viewRules')}</button>
          <button className="btn btn-ghost btn-block text-sm" onClick={complete}>{t('onb.skip')}</button>
        </div>
      </div>
    </Modal>
  );
}
