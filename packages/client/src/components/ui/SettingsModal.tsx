import { Modal } from './Modal.tsx';
import { useSettingsStore } from '../../store/settingsStore.ts';
import { sound } from '../../lib/sound.ts';

/** Audio settings: mute, master volume, and ambient music — persisted per device. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { muted, volume, musicOn, setMuted, setVolume, setMusicOn } = useSettingsStore();

  return (
    <Modal title="Cilësimet" onClose={onClose}>
      <div className="space-y-5">
        <Row label="Zëri (efektet)">
          <Toggle
            on={!muted}
            onChange={(on) => { setMuted(!on); if (on) sound.play('button'); }}
            labels={['Off', 'On']}
          />
        </Row>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="field-label">Volumi</span>
            <span className="text-xs text-muted tabular-nums">{Math.round(volume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            disabled={muted}
            aria-label="Volumi"
            aria-valuetext={`${Math.round(volume * 100)}%`}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            onMouseUp={() => sound.play('select')}
            className="w-full accent-gold disabled:opacity-40"
          />
        </div>

        <Row label="Muzika e sfondit">
          <Toggle on={musicOn} onChange={(on) => { setMusicOn(on); sound.play('button'); }} labels={['Off', 'On']} />
        </Row>

        <p className="text-xs text-muted/80">Cilësimet ruhen në këtë pajisje.</p>
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
