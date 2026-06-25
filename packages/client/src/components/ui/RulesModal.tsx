// "How to play" — a clear, scannable Murlan rules sheet, openable any time from the lobby
// (and linked from onboarding) so a newcomer can learn before risking money.
import { Modal } from './Modal.tsx';
import { useRulesStore } from '../../store/rulesStore.ts';
import { useT } from '../../lib/i18n.ts';

export function RulesModal() {
  const t = useT();
  const open = useRulesStore((s) => s.open);
  const setOpen = useRulesStore((s) => s.setOpen);
  if (!open) return null;

  const Row = ({ icon, title, body }: { icon: string; title: string; body: string }) => (
    <div className="flex gap-3">
      <span className="text-xl leading-none shrink-0" aria-hidden="true">{icon}</span>
      <div>
        <div className="font-display font-semibold text-gold-hi text-sm">{title}</div>
        <p className="text-sm text-muted leading-relaxed">{body}</p>
      </div>
    </div>
  );

  return (
    <Modal title={t('rules.title')} onClose={() => setOpen(false)}>
      <div className="space-y-4">
        <Row icon="🎯" title={t('rules.goalTitle')} body={t('rules.goalBody')} />
        <Row icon="🔢" title={t('rules.rankTitle')} body={t('rules.rankBody')} />
        <Row icon="🃏" title={t('rules.combosTitle')} body={t('rules.combosBody')} />
        <Row icon="💣" title={t('rules.bombTitle')} body={t('rules.bombBody')} />
        <Row icon="▶️" title={t('rules.playTitle')} body={t('rules.playBody')} />
        <Row icon="♠️" title={t('rules.openTitle')} body={t('rules.openBody')} />
        <Row icon="🔁" title={t('rules.switchTitle')} body={t('rules.switchBody')} />
        <button className="btn btn-gold btn-lg btn-block mt-1" onClick={() => setOpen(false)}>{t('rules.gotIt')}</button>
      </div>
    </Modal>
  );
}
