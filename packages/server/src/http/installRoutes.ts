// ============================================================================
// MURLAN — iOS install profile (Web Clip)
// ----------------------------------------------------------------------------
// Serves a .mobileconfig that, opened in Safari, downloads → Settings shows
// "Profile Downloaded" → Install → a full-screen "Crypto-Murlan" home-screen icon
// (landscape via the manifest + the in-app rotate lock). Built DYNAMICALLY from the
// request origin, so it always points at whatever domain it's served from — no
// hard-coded URL, works on prod/staging alike. Public (no auth): it carries no secrets.
// ============================================================================

import { log } from '../logger.ts';
import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import { WEBCLIP_ICON_B64 } from './iosWebClipIcon.ts';

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Sign the .mobileconfig (CMS / PKCS#7, DER) so iOS shows it as "Verified" (green) with NO
 * "Unsigned"/"Not Verified" warning. iOS only trusts a signature whose certificate chains to a root
 * in its trust store — i.e. a PUBLICLY-trusted cert, NOT a self-signed one. So sign with the domain's
 * own TLS certificate (Let's Encrypt fullchain + privkey), which already chains to a trusted root and
 * carries the domain name shown to the user.
 *
 * Wire it on the VPS by pointing these env vars at PEM files the server container can read:
 *   IOS_PROFILE_SIGN_CERT = fullchain.pem  (leaf + intermediate; e.g. the Caddy/Let's Encrypt cert)
 *   IOS_PROFILE_SIGN_KEY  = privkey.pem
 * If unset (or signing fails — missing openssl/bad cert), we fall back to the UNSIGNED profile so the
 * install still works, just with the warning until the cert is wired.
 *
 * ASYNC (spawn, not execFileSync): openssl runs in a child process WITHOUT blocking the single Node
 * event loop. The old synchronous execFileSync stalled all Socket.IO traffic + game turn timers for
 * the full openssl duration on every hit of this unauthenticated route — an event-loop-block DoS on a
 * single-instance realtime server (audit 2026-07-05). Results are also cached per origin (see below).
 */
function signProfile(plist: string): Promise<Buffer | null> {
  const cert = process.env.IOS_PROFILE_SIGN_CERT;
  const key = process.env.IOS_PROFILE_SIGN_KEY;
  if (!cert || !key) return Promise.resolve(null); // signing NOT configured — quiet fallback to unsigned
  return new Promise<Buffer | null>((resolve) => {
    // -nodetach embeds the plist in the signature (Apple requires the content inline); -certfile adds
    // the intermediate(s) from the same fullchain so iOS can build the path to the trusted root.
    const child = spawn(
      'openssl',
      ['smime', '-sign', '-signer', cert, '-inkey', key, '-certfile', cert, '-outform', 'DER', '-nodetach', '-md', 'sha256'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    const fail = (e: unknown): void => {
      // The env vars ARE set but signing FAILED (no openssl, or an unreadable/bad cert). Don't fail
      // silently — otherwise the profile serves 'Unsigned' forever with no clue why. Log it loudly.
      log.error(
        '[install] iOS .mobileconfig signing FAILED — serving UNSIGNED. Verify IOS_PROFILE_SIGN_CERT/KEY ' +
          "point at a readable, publicly-trusted (Let's Encrypt) fullchain+key and that openssl is installed.",
        e,
      );
      resolve(null); // serve unsigned (still installs, with the warning)
    };
    child.on('error', fail); // e.g. openssl not on PATH
    child.stdout.on('data', (d: Buffer) => { bytes += d.length; if (bytes <= 8 * 1024 * 1024) out.push(d); });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('close', (code) => {
      if (code === 0 && out.length) resolve(Buffer.concat(out));
      else fail(new Error(`openssl exited ${code}: ${Buffer.concat(err).toString().slice(0, 500)}`));
    });
    child.stdin.on('error', () => undefined); // swallow EPIPE if openssl exits before we finish writing
    child.stdin.end(plist);
  });
}

// Per-origin cache of the built (+ signed) profile. The profile is deterministic per origin, so we
// sign at most ONCE per distinct origin instead of on every request — this, plus async signing above,
// removes the DoS surface (a Host-rotation attacker is additionally bounded by MAX_CACHED_PROFILES +
// the per-route rate limit). A transient sign FAILURE (cert configured but openssl errored) is NOT
// cached, so it retries next request; the deterministic unsigned/signed success paths ARE cached.
const MAX_CACHED_PROFILES = 16;
const profileCache = new Map<string, Promise<{ body: Buffer | string; signed: boolean }>>();

function getProfile(origin: string): Promise<{ body: Buffer | string; signed: boolean }> {
  const hit = profileCache.get(origin);
  if (hit) return hit;
  const signingConfigured = !!(process.env.IOS_PROFILE_SIGN_CERT && process.env.IOS_PROFILE_SIGN_KEY);
  const built = (async () => {
    const plist = buildWebClipProfile(origin);
    const signed = await signProfile(plist);
    // Cert configured but sign failed → don't cache (let it retry once openssl/cert is fixed).
    if (signingConfigured && !signed) profileCache.delete(origin);
    return { body: signed ?? plist, signed: !!signed };
  })();
  built.catch(() => profileCache.delete(origin)); // never cache a rejection
  profileCache.set(origin, built);
  // Bound memory: evict the oldest entry if a Host-rotation flood grows the map.
  if (profileCache.size > MAX_CACHED_PROFILES) {
    const oldest = profileCache.keys().next().value;
    if (oldest !== undefined && oldest !== origin) profileCache.delete(oldest);
  }
  return built;
}

function buildWebClipProfile(appUrl: string): string {
  const url = xmlEscape(appUrl);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>PayloadIdentifier</key>
      <string>com.cryptomurlan.webclip</string>
      <key>PayloadUUID</key>
      <string>7C2F1E40-1A2B-4C3D-9E5F-CM0000WEBCLIP</string>
      <key>PayloadDisplayName</key>
      <string>Crypto-Murlan</string>
      <key>Label</key>
      <string>Crypto-Murlan</string>
      <key>URL</key>
      <string>${url}</string>
      <key>IsRemovable</key>
      <true/>
      <key>FullScreen</key>
      <true/>
      <key>Precomposed</key>
      <true/>
      <key>Icon</key>
      <data>${WEBCLIP_ICON_B64}</data>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadIdentifier</key>
  <string>com.cryptomurlan.profile</string>
  <key>PayloadUUID</key>
  <string>9B1D3A88-4E2C-4F71-A0C6-CM00000PROFILE</string>
  <key>PayloadDisplayName</key>
  <string>Crypto-Murlan</string>
  <key>PayloadDescription</key>
  <string>Instalon ikonën e Crypto-Murlan në ekranin kryesor (hapet si app, vetëm landscape).</string>
  <key>PayloadOrganization</key>
  <string>Crypto-Murlan</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
</dict>
</plist>`;
}

export async function installRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/install/ios.mobileconfig',
    // Tight per-route rate limit (defense-in-depth on top of async signing + the per-origin cache):
    // this is an unauthenticated route that can spawn openssl, so cap it well below the global limiter.
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      // Real public origin (nginx forwards Host + X-Forwarded-Proto). Fall back sanely for local dev.
      const proto = (typeof req.headers['x-forwarded-proto'] === 'string' && req.headers['x-forwarded-proto']) || req.protocol || 'https';
      const host = req.headers.host || 'localhost';
      // Build+sign at most once per origin (cached, async) → repeat hits and Host-rotation floods no
      // longer re-run openssl on the request path. Signed = iOS shows "Verified"; unsigned = installs
      // with an "Unsigned" note until the cert is wired.
      const { body, signed } = await getProfile(`${proto}://${host}/`);
      // The Content-Type is what makes Safari recognise it as a configuration profile (→ Settings → Install).
      reply
        .header('Content-Type', signed ? 'application/x-apple-aspen-config' : 'application/x-apple-aspen-config; charset=utf-8')
        .header('Cache-Control', 'no-store');
      return reply.send(body);
    },
  );
}
