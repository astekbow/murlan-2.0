import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../store/authStore.ts';
import { authApi } from '../lib/api.ts';

export function AuthView() {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const { status, error, login, register, clearError } = useAuthStore();
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
            <h1 className="gold-text font-display font-bold text-3xl tracking-wide leading-none">Rikuperim</h1>
            <p className="text-sm text-muted mt-2">Të dërgojmë një lidhje për të rivendosur fjalëkalimin.</p>
          </div>
          {forgotSent ? (
            <p className="text-sm text-emerald-200 text-center">
              Nëse ka një llogari me këtë email, lidhja u dërgua. Kontrollo email-in.
            </p>
          ) : (
            <>
              <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
              <button type="submit" disabled={forgotBusy} className="btn btn-gold btn-lg btn-block">
                {forgotBusy ? 'Po dërgohet…' : 'Dërgo lidhjen'}
              </button>
            </>
          )}
          <button type="button" className="btn btn-ghost btn-block" onClick={() => { setMode('login'); setForgotSent(false); clearError(); }}>
            ← Kthehu te hyrja
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
          <h1 className="gold-text font-display font-bold text-5xl tracking-wide leading-none">MURLAN</h1>
          <p className="text-sm text-muted mt-2">Luaj online për të vërtetë</p>
        </div>

        <div className="seg grid grid-cols-2 w-full">
          <button
            type="button"
            onClick={() => { setMode('login'); clearError(); }}
            className={`seg-tab text-center ${mode === 'login' ? 'active' : ''}`}
          >
            HYR
          </button>
          <button
            type="button"
            onClick={() => { setMode('register'); clearError(); }}
            className={`seg-tab text-center ${mode === 'register' ? 'active' : ''}`}
          >
            REGJISTROHU
          </button>
        </div>

        {mode === 'register' && (
          <Field label="Përdoruesi" value={username} onChange={setUsername} autoComplete="username" required minLength={3} />
        )}
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
        <Field
          label="Fjalëkalimi"
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
          {loading ? 'Duke u procesuar…' : mode === 'login' ? 'HYR' : 'KRIJO LLOGARI'}
        </button>

        {mode === 'login' && (
          <button type="button" onClick={() => { setMode('forgot'); clearError(); }} className="block w-full text-center text-xs text-gold-hi border-b border-dashed border-gold/40 pb-0.5 mx-auto" style={{ width: 'fit-content' }}>
            Harrove fjalëkalimin?
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
        onChange={(e) => onChange(e.target.value)}
        className="field"
      />
    </label>
  );
}
