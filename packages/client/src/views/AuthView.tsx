import { useState, type FormEvent } from 'react';
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

/** Login-page "get the app" buttons: iPhone (iOS Web Clip profile) + Android (.apk). Each starts the
 *  download AND opens a step-by-step guide for THAT platform. The player's own device is highlighted. */
function AppDownload() {
  const t = useT();
  const [guide, setGuide] = useState<null | 'ios' | 'android'>(null);
  const device: 'ios' | 'android' | null = isIos() ? 'ios' : (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) ? 'android' : null;

  return (
    <div className="w-full max-w-sm text-center">
      <p className="font-serif text-[11px] tracking-[0.25em] text-muted/80 uppercase mb-1.5">📲 {t('download.prompt')}</p>
      <div className="flex gap-2">
        {/* iOS: navigating to the profile triggers the Safari "install profile" flow. */}
        <a href="/api/install/ios.mobileconfig" onClick={() => setGuide('ios')} className={`btn btn-sm flex-1 ${device === 'ios' ? 'btn-gold' : 'btn-ghost'}`}>🍎 {t('download.ios')}</a>
        {/* Android: download attribute saves the .apk. */}
        <a href="/install/crypto-murlan.apk" download onClick={() => setGuide('android')} className={`btn btn-sm flex-1 ${device === 'android' ? 'btn-gold' : 'btn-ghost'}`}>🤖 {t('download.android')}</a>
      </div>

      {guide === 'ios' && (
        <Modal title={t('download.iosTitle')} onClose={() => setGuide(null)}>
          <p className="text-xs text-amber-300 mb-3 leading-relaxed">{t('download.iosOpenSafari')}</p>
          <DownloadSteps items={[t('download.ios1'), t('download.ios2'), t('download.ios3')]} />
        </Modal>
      )}
      {guide === 'android' && (
        <Modal title={t('download.androidTitle')} onClose={() => setGuide(null)}>
          <DownloadSteps items={[t('download.android1'), t('download.android2'), t('download.android3')]} />
        </Modal>
      )}
    </div>
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
