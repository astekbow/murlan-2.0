import { useState, useEffect, type FormEvent } from 'react';
import { useAuthStore } from '../store/authStore.ts';
import { authApi } from '../lib/api.ts';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { isIos, isStandalone } from '../lib/pwa.ts';
import { Modal } from '../components/ui/Modal.tsx';
import { useT, useLangStore, type Lang } from '../lib/i18n.ts';

export function AuthView() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const { status, error, login, register, clearError } = useAuthStore();
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const setLang = useLangStore((s) => s.setLang);
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
    <div className="relative z-10 min-h-full flex items-center justify-center p-3">
      {/* On a short LANDSCAPE phone the stacked form is taller than the screen → it scrolls. There
          we switch to a compact two-column card (branding | form) so it fits with NO scroll. */}
      <form
        onSubmit={submit}
        className={`panel-solid w-full animate-rise ${landscape ? 'max-w-2xl p-5 grid grid-cols-2 gap-6 items-center' : 'max-w-sm p-7 space-y-5'}`}
      >
        <div className="text-center">
          {/* Brand logo on top — the self-contained app icon (its own dark bg shows on the panel). */}
          <img
            src="/icon-192.png"
            alt="Crypto-Murlan"
            className={`mx-auto rounded-2xl shadow-lg ring-1 ring-gold/25 mb-3 ${landscape ? 'w-20 h-20' : 'w-16 h-16'}`}
          />
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">CARD CLUB</div>
          <h1 className={`gold-text font-display font-bold tracking-wide leading-none ${landscape ? 'text-3xl' : 'text-4xl'}`}>CRYPTO-MURLAN</h1>
          {/* Get the app — iPhone + Android buttons right under the title (no bottom-of-page scroll). */}
          {!isStandalone() && <AppDownload landscape={landscape} />}
          {/* Language pill — a pre-login switch (the app defaults to Albanian). */}
          <div className="mt-3 inline-flex rounded-full border border-gold/25 overflow-hidden text-xs" role="radiogroup" aria-label={t('settings.language')}>
            {(['sq', 'en'] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={lang === l}
                onClick={() => setLang(l)}
                className={`px-3 py-1 ${lang === l ? 'bg-gold/20 text-gold-hi' : 'text-muted'}`}
              >
                {l === 'sq' ? 'SQ' : 'EN'}
              </button>
            ))}
          </div>
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
    </div>
  );
}

/** "Get the app" — iPhone + Android buttons shown INLINE under the brand title (no bottom-of-page
 *  scroll; everything stays in the one card). Each button starts the download AND opens a per-device
 *  step-by-step guide. The visitor's own platform is highlighted. */
function AppDownload({ landscape }: { landscape: boolean }) {
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

  return (
    <div className={landscape ? 'pt-2' : 'pt-3'}>
      <p className="font-serif text-[10px] tracking-[0.25em] text-muted/80 uppercase mb-1.5">📲 {t('download.prompt')}</p>
      <div className="flex gap-2">
        {/* iOS: navigating to the profile triggers the Safari "install profile" flow. */}
        <a href="/api/install/ios.mobileconfig" onClick={() => setGuide('ios')} className={`btn btn-sm flex-1 ${device === 'ios' ? 'btn-gold' : 'btn-ghost'}`}>🍎 {t('download.ios')}</a>
        {/* Android: the download attr saves the .apk (disabled with a note until it's hosted). */}
        {apkOk === false ? (
          <button type="button" disabled className="btn btn-ghost btn-sm flex-1 opacity-60 cursor-not-allowed">🤖 {t('download.android')}</button>
        ) : (
          <a href="/install/crypto-murlan.apk" download onClick={() => setGuide('android')} className={`btn btn-sm flex-1 ${device === 'android' ? 'btn-gold' : 'btn-ghost'}`}>🤖 {t('download.android')}</a>
        )}
      </div>
      {apkOk === false && <p className="text-[10px] text-amber-300 mt-1">{t('download.apkMissing')}</p>}

      {/* Per-device install guide (modal) — opens when a button is tapped. */}
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
