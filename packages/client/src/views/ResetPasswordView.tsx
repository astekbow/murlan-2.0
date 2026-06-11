import { useState } from 'react';
import { authApi, ApiError } from '../lib/api.ts';
import { useT } from '../lib/i18n.ts';

/**
 * Shown when a password-reset email link is opened (`?resetPassword=<token>`).
 * Sets a new password, then returns the user to the login screen. Pre-auth and
 * standalone — it never needs an access token.
 */
export function ResetPasswordView({ token, onDone }: { token: string; onDone: () => void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (password.length < 8) return setError(t('reset.errMinLength'));
    if (password !== confirm) return setError(t('reset.errMismatch'));
    setError(null);
    setBusy(true);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('reset.errFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="min-h-full flex items-center justify-center"
      style={{ padding: 'max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))' }}
    >
      <div className="panel-solid w-full max-w-sm p-7 space-y-4 animate-pop">
        <h1 className="gold-text font-display font-bold tracking-wide text-2xl text-center">{t('reset.title')}</h1>
        {done ? (
          <>
            <p className="text-sm text-emerald-200 text-center">{t('reset.success')}</p>
            <button className="btn btn-gold btn-block" onClick={onDone}>{t('reset.goToLogin')}</button>
          </>
        ) : (
          <>
            <label className="block">
              <span className="field-label">{t('reset.newPassword')}</span>
              <input type="password" className="field" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="block">
              <span className="field-label">{t('reset.confirmPassword')}</span>
              <input type="password" className="field" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
            </label>
            {error && <div className="text-sm text-red-300">{error}</div>}
            <button className="btn btn-gold btn-block" disabled={busy} onClick={() => void submit()}>
              {busy ? t('reset.saving') : t('reset.submit')}
            </button>
            <button className="btn btn-ghost btn-block" onClick={onDone}>{t('common.cancel')}</button>
          </>
        )}
      </div>
    </div>
  );
}
