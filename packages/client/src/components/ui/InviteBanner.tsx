import type { MatchType } from '@murlan/shared';
import { useGameStore } from '../../store/gameStore.ts';
import { dollars } from '../../lib/money.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';

const TYPE_LABEL_KEY: Record<MatchType, string> = { '1v1': 'lobby.type1v1', '1v1v1': 'lobby.type1v1v1', '2v2': 'lobby.type2v2' };

/** A friend room invite, shown as a dismissible banner at the bottom. */
export function InviteBanner() {
  const t = useT();
  const invite = useGameStore((s) => s.invite);
  const accept = useGameStore((s) => s.acceptInvite);
  const dismiss = useGameStore((s) => s.dismissInvite);
  if (!invite) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-[55] flex justify-center px-4 pointer-events-none">
      <div className="panel-solid pointer-events-auto flex items-center gap-3 px-4 py-3 max-w-md w-full animate-pop">
        <div className="text-2xl">📨</div>
        <div className="flex-1 min-w-0 text-sm">
          <b className="text-gold-hi">{invite.fromUsername}</b> {t('invite.invitedYouTo')}{' '}
          <b>{t(TYPE_LABEL_KEY[invite.type])}</b> · {dollars(invite.stakeCents)}
        </div>
        <button className="btn btn-ghost" onClick={dismiss}>{t('invite.no')}</button>
        <button className="btn btn-green" onClick={() => { sound.play('button'); void accept(); }}>{t('invite.join')}</button>
      </div>
    </div>
  );
}
