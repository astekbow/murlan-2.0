// ============================================================================
// MURLAN — Production compliance-config gate (CI)
// ----------------------------------------------------------------------------
// Fails the build (exit 1) if loadConfig would boot a PRODUCTION app without the
// compliance gates being an explicit, deliberate decision. This is a named CI
// gate so a real-money deploy can never silently ship with KYC/age/geo
// enforcement off (the unit test covers the same guard; this surfaces it as a
// standalone go/no-go signal in the pipeline).
// ============================================================================

import { loadConfig } from '../src/config.ts';

const prodSecrets: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'r'.repeat(40),
  PAYMENT_WEBHOOK_SECRET: 'w'.repeat(40),
  // NOTE: compliance flags deliberately omitted — the guard MUST reject this.
};

try {
  loadConfig(prodSecrets);
  console.error('FAIL: production config guard is INACTIVE — a prod build booted with no explicit compliance flags.');
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Compliance flags must be explicitly configured/.test(msg)) {
    console.log('OK: production requires explicit KYC/age/geo/responsible-gaming flags.');
    process.exit(0);
  }
  console.error('FAIL: unexpected config error (expected the compliance guard):', msg);
  process.exit(1);
}
