import { useGameStore } from '../../store/gameStore.ts';
import { sound } from '../../lib/sound.ts';
import { useT } from '../../lib/i18n.ts';
import { Icon } from './Icon.tsx';

/** An incoming club invite from a friend, shown as a dismissible banner at the bottom.
 *  Mirrors InviteBanner — one-tap "join" reuses join/joinByCode under the hood. */
export function ClubInviteBanner() {
  const t = useT();
  const invite = useGameStore((s) => s.clubInvite);
  const accept = useGameStore((s) => s.acceptClubInvite);
  const dismiss = useGameStore((s) => s.dismissClubInvite);
  if (!invite) return null;

  return (
    <div
      className="float-bottom fixed inset-x-0 z-[55] flex justify-center pointer-events-none"
      style={{
        // .float-bottom clears the home indicator AND the portrait bottom tab bar.
        paddingLeft: 'max(1rem, env(safe-area-inset-left))',
        paddingRight: 'max(1rem, env(safe-area-inset-right))',
      }}
    >
      <div className="panel-solid pointer-events-auto flex items-center gap-3 px-4 py-3 max-w-md w-full animate-pop">
        <span className="grid place-items-center w-10 h-10 rounded-full bg-gold/15 text-gold-hi shrink-0" aria-hidden><Icon name="shield" size={20} /></span>
        <div className="flex-1 min-w-0 text-sm">
          <b className="text-gold-hi">{invite.fromUsername}</b> {t('clubInvite.invitedYouTo')}{' '}
          <b>[{invite.tag}] {invite.clubName}</b>
        </div>
        <button className="btn btn-ghost" onClick={dismiss}>{t('invite.no')}</button>
        <button className="btn btn-green" onClick={() => { sound.play('button'); void accept(); }}>{t('clubs.join')}</button>
      </div>
    </div>
  );
}
