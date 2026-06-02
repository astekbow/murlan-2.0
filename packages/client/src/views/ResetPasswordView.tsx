import { useState } from 'react';
import { authApi, ApiError } from '../lib/api.ts';

/**
 * Shown when a password-reset email link is opened (`?resetPassword=<token>`).
 * Sets a new password, then returns the user to the login screen. Pre-auth and
 * standalone — it never needs an access token.
 */
export function ResetPasswordView({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (password.length < 8) return setError('Fjalëkalimi duhet të ketë të paktën 8 karaktere.');
    if (password !== confirm) return setError('Fjalëkalimet nuk përputhen.');
    setError(null);
    setBusy(true);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Rivendosja dështoi.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center px-4">
      <div className="panel-solid w-full max-w-sm p-7 space-y-4 animate-pop">
        <h1 className="gold-text font-display font-bold tracking-wide text-2xl text-center">Rivendos fjalëkalimin</h1>
        {done ? (
          <>
            <p className="text-sm text-emerald-200 text-center">Fjalëkalimi u rivendos. Tani mund të hysh.</p>
            <button className="btn btn-gold btn-block" onClick={onDone}>Shko te hyrja</button>
          </>
        ) : (
          <>
            <label className="block">
              <span className="field-label">Fjalëkalimi i ri</span>
              <input type="password" className="field" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="block">
              <span className="field-label">Konfirmo fjalëkalimin</span>
              <input type="password" className="field" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
            </label>
            {error && <div className="text-sm text-red-300">{error}</div>}
            <button className="btn btn-gold btn-block" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Po ruhet…' : 'Rivendos'}
            </button>
            <button className="btn btn-ghost btn-block" onClick={onDone}>Anulo</button>
          </>
        )}
      </div>
    </div>
  );
}
