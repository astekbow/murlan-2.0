import { useState, useEffect, type FormEvent } from 'react';
import { useAuthStore } from '../store/authStore.ts';
import { authApi } from '../lib/api.ts';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { isIos, isStandalone } from '../lib/pwa.ts';
import { Modal } from '../components/ui/Modal.tsx';
import { useT } from '../lib/i18n.ts';

export function AuthView() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const { status, error, login, register, clearError } = useAuthStore();
  const t = useT();
  const landscape = useLandscapePage();
  const loading = status === 'loading';

  async function submit(e: FormEvent) {
    e.preventDefault();
    clearError();
    if (mode === 'forgot') {
      setForgotBusy(true);
      try { await authApi.forgotPassword(email.trim()); } catch { /* always succeeds UX-wise */ }
      setForgotBusy(false);
      setForgotSent(true); // generic confirmation regardless (no account enumeration)
      return;
    }
    if (mode === 'login') await login({ email, password });
    else await register({ username, email, password });
  }

  if (mode === 'forgot') {
    return (
      <div
        className="relative z-10 min-h-full flex items-center justify-center"
        style={{ padding: 'max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))' }}
      >
        <form onSubmit={submit} className="panel-solid w-full max-w-sm p-7 space-y-5 animate-rise">
          <div className="text-center">
            <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">{t('auth.recoverTitle')}</h1>
            <p className="text-sm text-muted mt-2">{t('auth.recoverBlurb')}</p>
          </div>
          {forgotSent ? (
            <p className="text-sm text-emerald-200 text-center">{t('auth.recoverSent')}</p>
          ) : (
            <>
              <Field label={t('auth.email')} type="email" value={email} onChange={setEmail} autoComplete="email" required />
              <button type="submit" disabled={forgotBusy} className="btn btn-gold btn-lg btn-block">
                {forgotBusy ? t('auth.sending') : t('auth.sendLink')}
              </button>
            </>
          )}
          <button type="button" className="btn btn-ghost btn-block" onClick={() => { setMode('login'); setForgotSent(false); clearError(); }}>
            {t('auth.backToLogin')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="relative z-10 min-h-full flex flex-col items-center justify-center gap-3 p-3">
      {/* On a short LANDSCAPE phone the stacked form is taller than the screen → it scrolls. There
          we switch to a compact two-column card (branding | form) so it fits with NO scroll. */}
      <form
        onSubmit={submit}
        className={`panel-solid w-full animate-rise ${landscape ? 'max-w-2xl p-5 grid grid-cols-2 gap-6 items-center' : 'max-w-sm p-7 space-y-5'}`}
      >
        <div className="text-center">
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">CARD CLUB</div>
          <h1 className={`gold-text font-display font-bold tracking-wide leading-none ${landscape ? 'text-3xl' : 'text-4xl'}`}>CRYPTO-MURLAN</h1>
        </div>

        <div className={landscape ? 'space-y-3 min-w-0' : 'space-y-5'}>
          <div className="seg grid grid-cols-2 w-full" role="radiogroup" aria-label={t('auth.login')}>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'login'}
              onClick={() => { setMode('login'); clearError(); }}
              className={`seg-tab text-center ${mode === 'login' ? 'active' : ''}`}
            >
              {t('auth.login')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'register'}
              onClick={() => { setMode('register'); clearError(); }}
              className={`seg-tab text-center ${mode === 'register' ? 'active' : ''}`}
            >
              {t('auth.register')}
            </button>
          </div>

          {mode === 'register' && (
            <Field label={t('auth.username')} value={username} onChange={setUsername} autoComplete="username" required minLength={3} invalid={!!error} describedBy={error ? 'auth-error' : undefined} />
          )}
          <Field label={t('auth.email')} type="email" value={email} onChange={setEmail} autoComplete="email" required invalid={!!error} describedBy={error ? 'auth-error' : undefined} />
          <Field
            label={t('auth.password')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'register' ? 8 : undefined}
            invalid={!!error}
            describedBy={error ? 'auth-error' : undefined}
          />

          {error && (
            <div id="auth-error" role="alert" className="text-sm text-red-300 bg-suit/15 border border-suit/40 rounded-lg px-3 py-2">{error}</div>
          )}

          <button type="submit" disabled={loading} className={`btn btn-gold btn-block ${landscape ? '' : 'btn-lg'}`}>
            {loading ? t('auth.processing') : mode === 'login' ? t('auth.submitLogin') : t('auth.submitRegister')}
          </button>

          {mode === 'login' && (
            <button type="button" onClick={() => { setMode('forgot'); clearError(); }} className="block w-full text-center text-xs text-gold-hi border-b border-dashed border-gold/40 pb-0.5 mx-auto" style={{ width: 'fit-content' }}>
              {t('auth.forgot')}
            </button>
          )}
        </div>
      </form>

      {/* Download the native-feeling app — one button per platform (only before it's installed). */}
      {!isStandalone() && <AppDownload />}
    </div>
  );
}

/** A compact "Get the app" link below the login form (one line → no extra scroll). Tapping opens a
 *  modal with the two platform buttons + a per-device step-by-step guide. */
function AppDownload() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full text-center text-xs text-gold-hi border-b border-dashed border-gold/40 pb-0.5 mx-auto"
        style={{ width: 'fit-content' }}
      >
        📲 {t('download.prompt')}
      </button>
      {open && <DownloadModal onClose={() => setOpen(false)} />}
    </>
  );
}

function DownloadModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [guide, setGuide] = useState<null | 'ios' | 'android'>(null);
  // Is the Android .apk actually hosted yet? (HEAD check) — until it is, show a friendly note instead
  // of a "download failed". null = checking, true/false = result.
  const [apkOk, setApkOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/install/crypto-murlan.apk', { method: 'HEAD' })
      .then((r) => { if (alive) setApkOk(r.ok); })
      .catch(() => { if (alive) setApkOk(false); });
    return () => { alive = false; };
  }, []);
  const device: 'ios' | 'android' | null = isIos() ? 'ios' : (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) ? 'android' : null;

  const title = guide === 'ios' ? t('download.iosTitle') : guide === 'android' ? t('download.androidTitle') : t('download.prompt');
  return (
    <Modal title={title} onClose={onClose}>
      {guide === null ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{t('download.pick')}</p>
          <div className="flex gap-2">
            <a href="/api/install/ios.mobileconfig" onClick={() => setGuide('ios')} className={`btn flex-1 ${device === 'ios' ? 'btn-gold' : 'btn-ghost'}`}>🍎 {t('download.ios')}</a>
            {apkOk === false ? (
              <button type="button" disabled className="btn btn-ghost flex-1 opacity-60 cursor-not-allowed">🤖 {t('download.android')}</button>
            ) : (
              <a href="/install/crypto-murlan.apk" download onClick={() => setGuide('android')} className={`btn flex-1 ${device === 'android' ? 'btn-gold' : 'btn-ghost'}`}>🤖 {t('download.android')}</a>
            )}
          </div>
          {apkOk === false && <p className="text-[11px] text-amber-300">{t('download.apkMissing')}</p>}
        </div>
      ) : guide === 'ios' ? (
        <>
          <p className="text-xs text-amber-300 mb-3 leading-relaxed">{t('download.iosOpenSafari')}</p>
          <DownloadSteps items={[t('download.ios1'), t('download.ios2'), t('download.ios3')]} />
          <button type="button" className="btn btn-ghost btn-sm btn-block mt-4" onClick={() => setGuide(null)}>← {t('download.back')}</button>
        </>
      ) : (
        <>
          <DownloadSteps items={[t('download.android1'), t('download.android2'), t('download.android3')]} />
          <button type="button" className="btn btn-ghost btn-sm btn-block mt-4" onClick={() => setGuide(null)}>← {t('download.back')}</button>
        </>
      )}
    </Modal>
  );
}

function DownloadSteps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-3 text-sm text-txt">
      {items.map((s, i) => (
        <li key={i} className="flex items-start gap-3">
          <span className="shrink-0 w-6 h-6 grid place-items-center rounded-full bg-gold/15 text-gold-hi font-display font-bold text-xs">{i + 1}</span>
          <span className="leading-relaxed">{s}</span>
        </li>
      ))}
    </ol>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  invalid?: boolean;
  describedBy?: string;
}
function Field({ label, value, onChange, type = 'text', autoComplete, required, minLength, invalid, describedBy }: FieldProps) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        // Stop mobile keyboards from auto-capitalizing/autocorrecting credentials
        // (an auto-capped first letter in the email was breaking login).
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode={type === 'email' ? 'email' : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="field"
      />
    </label>
  );
}
