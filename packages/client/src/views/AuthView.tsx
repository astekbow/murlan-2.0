import { useState, useEffect, type FormEvent } from 'react';
import { useAuthStore } from '../store/authStore.ts';
import { authApi } from '../lib/api.ts';
import { useLandscapePage } from '../lib/useLandscapePage.ts';
import { isIos, isStandalone } from '../lib/pwa.ts';
import { Modal } from '../components/ui/Modal.tsx';
import { InstallGuide } from '../components/ui/InstallGuide.tsx';
import { useT, useLangStore, type Lang } from '../lib/i18n.ts';

export function AuthView() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed18, setAgreed18] = useState(false); // register: must confirm 18+ / accept the terms
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

          {/* aria-describedby (not blanket aria-invalid) links the error to the fields — a generic
              server error like "wrong credentials" no longer marks EVERY field invalid. */}
          {mode === 'register' && (
            <Field label={t('auth.username')} value={username} onChange={setUsername} autoComplete="username" required minLength={3} describedBy={error ? 'auth-error' : undefined} />
          )}
          <Field label={t('auth.email')} type="email" value={email} onChange={setEmail} autoComplete="email" required describedBy={error ? 'auth-error' : undefined} />
          <Field
            label={t('auth.password')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'register' ? 8 : undefined}
            describedBy={error ? 'auth-error' : undefined}
            hint={mode === 'register' ? t('auth.pwRule') : undefined}
          />

          {/* 18+ / terms gate on the real-money register screen (compliance + trust). */}
          {mode === 'register' && (
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={agreed18} onChange={(e) => setAgreed18(e.target.checked)} className="mt-0.5 w-4 h-4 accent-gold shrink-0" />
              <span className="text-[12px] text-muted leading-snug">{t('auth.age18')}</span>
            </label>
          )}

          {error && (
            <div id="auth-error" role="alert" className="text-sm text-red-300 bg-suit/15 border border-suit/40 rounded-lg px-3 py-2">{error}</div>
          )}

          <button type="submit" disabled={loading || (mode === 'register' && !agreed18)} className={`btn btn-gold btn-block ${landscape ? '' : 'btn-lg'}`}>
            {loading ? t('auth.processing') : mode === 'login' ? t('auth.submitLogin') : t('auth.submitRegister')}
          </button>

          {mode === 'login' && (
            <button type="button" onClick={() => { setMode('forgot'); clearError(); }} className="block w-full text-center text-xs text-gold-hi border-b border-dashed border-gold/40 pb-0.5 mx-auto" style={{ width: 'fit-content' }}>
              {t('auth.forgot')}
            </button>
          )}

          {/* "Get the app" moved BELOW the sign-in form so login is the hero, not the install prompt. */}
          {!isStandalone() && <AppDownload landscape={landscape} />}
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
      <p className="font-serif text-[10px] tracking-[0.25em] text-muted/80 uppercase mb-1.5">{t('download.prompt')}</p>
      <div className="flex gap-2">
        {/* iOS: open the shared install guide (its gold CTA triggers the profile download in Safari). */}
        <button type="button" onClick={() => setGuide('ios')} className={`btn btn-sm flex-1 inline-flex items-center justify-center gap-1.5 ${device === 'ios' ? 'btn-gold' : 'btn-ghost'}`}>
          <AppleGlyph /> {t('download.ios')}
        </button>
        {/* Android: the download attr saves the .apk (disabled with a note until it's hosted). */}
        {apkOk === false ? (
          <button type="button" disabled className="btn btn-ghost btn-sm flex-1 inline-flex items-center justify-center gap-1.5 opacity-60 cursor-not-allowed">
            <AndroidGlyph /> {t('download.android')}
          </button>
        ) : (
          <a href="/install/crypto-murlan.apk" download onClick={() => setGuide('android')} className={`btn btn-sm flex-1 inline-flex items-center justify-center gap-1.5 ${device === 'android' ? 'btn-gold' : 'btn-ghost'}`}>
            <AndroidGlyph /> {t('download.android')}
          </a>
        )}
      </div>
      {apkOk === false && <p className="text-[10px] text-amber-300 mt-1">{t('download.apkMissing')}</p>}

      {/* Per-device install guide (modal) — opens when a button is tapped. */}
      {guide === 'ios' && (
        <Modal title={t('download.iosTitle')} onClose={() => setGuide(null)}>
          <InstallGuide />
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

/** Platform glyphs for the download buttons — Apple mark + Android robot (currentColor). */
function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.51 4.09l-.02-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}
function AndroidGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zM15.53 2.16l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 1.23 12.95 1 12 1c-.96 0-1.86.23-2.66.63L7.85.15c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 3.26 6 5.01 6 7h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z" />
    </svg>
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
  hint?: string; // small helper line under the field (e.g. password rules)
}
function Field({ label, value, onChange, type = 'text', autoComplete, required, minLength, invalid, describedBy, hint }: FieldProps) {
  const t = useT();
  const isPw = type === 'password';
  const [show, setShow] = useState(false);
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <div className="relative">
        <input
          type={isPw && show ? 'text' : type}
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
          className={`field ${isPw ? 'pr-14' : ''}`}
        />
        {/* Show/hide toggle — typing a password blind on a phone is the biggest login friction. */}
        {isPw && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? t('auth.hidePw') : t('auth.showPw')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-display font-semibold uppercase tracking-wide text-gold-hi px-1.5 py-1 rounded-md hover:bg-gold/[.12]"
          >
            {show ? t('auth.hide') : t('auth.show')}
          </button>
        )}
      </div>
      {hint && <p className="text-[11px] text-muted/80 mt-1">{hint}</p>}
    </label>
  );
}
