import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../store/authStore.ts';
import { authApi } from '../lib/api.ts';
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
      <div className="relative z-10 min-h-full flex items-center justify-center p-4">
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
    <div className="relative z-10 min-h-full flex items-center justify-center p-4">
      <form onSubmit={submit} className="panel-solid w-full max-w-sm p-7 space-y-5 animate-rise">
        <div className="text-center">
          <div className="font-serif text-xs tracking-[0.4em] text-muted mb-1">CARD CLUB</div>
          <h1 className="gold-text font-display font-bold text-4xl tracking-wide leading-none">CRYPTO-MURLAN</h1>
        </div>

        <div className="seg grid grid-cols-2 w-full">
          <button
            type="button"
            onClick={() => { setMode('login'); clearError(); }}
            className={`seg-tab text-center ${mode === 'login' ? 'active' : ''}`}
          >
            {t('auth.login')}
          </button>
          <button
            type="button"
            onClick={() => { setMode('register'); clearError(); }}
            className={`seg-tab text-center ${mode === 'register' ? 'active' : ''}`}
          >
            {t('auth.register')}
          </button>
        </div>

        {mode === 'register' && (
          <Field label={t('auth.username')} value={username} onChange={setUsername} autoComplete="username" required minLength={3} />
        )}
        <Field label={t('auth.email')} type="email" value={email} onChange={setEmail} autoComplete="email" required />
        <Field
          label={t('auth.password')}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          required
          minLength={mode === 'register' ? 8 : undefined}
        />

        {error && (
          <div className="text-sm text-red-300 bg-suit/15 border border-suit/40 rounded-lg px-3 py-2">{error}</div>
        )}

        <button type="submit" disabled={loading} className="btn btn-gold btn-lg btn-block">
          {loading ? t('auth.processing') : mode === 'login' ? t('auth.submitLogin') : t('auth.submitRegister')}
        </button>

        {mode === 'login' && (
          <button type="button" onClick={() => { setMode('forgot'); clearError(); }} className="block w-full text-center text-xs text-gold-hi border-b border-dashed border-gold/40 pb-0.5 mx-auto" style={{ width: 'fit-content' }}>
            {t('auth.forgot')}
          </button>
        )}
      </form>
    </div>
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
}
function Field({ label, value, onChange, type = 'text', autoComplete, required, minLength }: FieldProps) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
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
