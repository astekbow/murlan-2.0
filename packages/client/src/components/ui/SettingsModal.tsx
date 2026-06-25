import { Modal } from './Modal.tsx';
import { useSettingsStore } from '../../store/settingsStore.ts';
import { useSessionStore, useSessionMinutes, formatSessionDuration } from '../../store/sessionStore.ts';
import { useRulesStore } from '../../store/rulesStore.ts';
import { useWalletStore } from '../../store/walletStore.ts';
import { dollars } from '../../lib/money.ts';
import { sound } from '../../lib/sound.ts';
import { useT, useLangStore, type Lang } from '../../lib/i18n.ts';

/** Audio settings: mute, master volume, and ambient music — persisted per device. */
const RC_OPTIONS = [0, 15, 30, 60];
const LANGS: Array<{ id: Lang; label: string }> = [{ id: 'sq', label: 'Shqip' }, { id: 'en', label: 'English' }];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { muted, volume, musicOn, realityCheckMinutes, setMuted, setVolume, setMusicOn, setRealityCheckMinutes } = useSettingsStore();
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
  const minutes = useSessionMinutes();
  const games = useSessionStore((s) => s.games);
  const startBal = useSessionStore((s) => s.startBalanceCents);
  const curBal = useWalletStore((s) => s.balanceCents);
  const delta = startBal != null ? curBal - startBal : null;

  return (
    <Modal title={t('settings.title')} onClose={onClose}>
      <div className="space-y-5">
        {/* How to play — opens the rules sheet (and closes Settings so they don't stack). */}
        <button className="btn btn-ghost btn-block" onClick={() => { useRulesStore.getState().setOpen(true); onClose(); }}>{t('rules.openBtn')}</button>

        {/* Language */}
        <div>
          <div className="field-label">{t('settings.language')}</div>
          <div className="seg w-full grid grid-cols-2 mt-1" role="radiogroup" aria-label={t('settings.language')}>
            {LANGS.map((l) => (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={lang === l.id}
                className={`seg-tab text-center ${lang === l.id ? 'active' : ''}`}
                onClick={() => { setLang(l.id); sound.play('button'); }}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <Row label={t('settings.soundFx')}>
          <Toggle
            on={!muted}
            onChange={(on) => { setMuted(!on); if (on) sound.play('button'); }}
            labels={['Off', 'On']}
          />
        </Row>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="field-label">{t('settings.volume')}</span>
            <span className="text-xs text-muted tabular-nums">{Math.round(volume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            disabled={muted}
            aria-label={t('settings.volume')}
            aria-valuetext={`${Math.round(volume * 100)}%`}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            onMouseUp={() => sound.play('select')}
            className="w-full accent-gold disabled:opacity-40"
          />
        </div>

        <Row label={t('settings.music')}>
          <Toggle on={musicOn} onChange={(on) => { setMusicOn(on); sound.play('button'); }} labels={['Off', 'On']} />
        </Row>

        {/* Responsible gaming: a periodic reality-check reminder. */}
        <div className="pt-1 border-t border-white/10">
          <div className="field-label mt-3">{t('settings.realityCheck')}</div>
          <div className="seg w-full grid grid-cols-4 mt-1" role="radiogroup" aria-label={t('settings.realityCheck')}>
            {RC_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={realityCheckMinutes === m}
                className={`seg-tab text-center ${realityCheckMinutes === m ? 'active' : ''}`}
                onClick={() => { setRealityCheckMinutes(m); sound.play('button'); }}
              >
                {m === 0 ? 'Off' : `${m}m`}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted/80 mt-1.5">{t('settings.realityCheckHint')}</p>
        </div>

        {/* Session recap (responsible-gaming nudge): time + games + net balance change. */}
        <div>
          <div className="field-label">{t('settings.sessionRecap')}</div>
          <p className="text-sm text-txt mt-1">
            {t('settings.sessionLine', { dur: formatSessionDuration(minutes), games })}
            {delta != null && (
              <> · <span className={delta >= 0 ? 'text-emerald-300' : 'text-red-300'} title={t('settings.sessionDeltaHint')}>{delta >= 0 ? '+' : '−'}{dollars(Math.abs(delta))}</span></>
            )}
          </p>
          {delta != null && <p className="text-[11px] text-muted/60 mt-1">{t('settings.sessionDeltaHint')}</p>}
          <p className="text-[11px] text-muted/80 mt-1">{t('settings.sessionHint')}</p>
        </div>

        <p className="text-xs text-muted/80">{t('settings.savedOnDevice')}</p>
      </div>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-txt">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ on, onChange, labels }: { on: boolean; onChange: (on: boolean) => void; labels: [string, string] }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative w-14 h-7 rounded-full transition-colors border ${on ? 'bg-emerald2/80 border-emerald2' : 'bg-black/40 border-gold/30'}`}
    >
      <span className="sr-only">{on ? labels[1] : labels[0]}</span>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-cream shadow transition-all ${on ? 'left-[30px]' : 'left-0.5'}`} />
    </button>
  );
}
