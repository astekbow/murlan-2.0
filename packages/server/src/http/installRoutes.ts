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
import { execFileSync } from 'node:child_process';
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
 */
function signProfile(plist: string): Buffer | null {
  const cert = process.env.IOS_PROFILE_SIGN_CERT;
  const key = process.env.IOS_PROFILE_SIGN_KEY;
  if (!cert || !key) return null; // signing NOT configured — expected, quiet fallback to unsigned
  try {
    // -nodetach embeds the plist in the signature (Apple requires the content inline); -certfile adds
    // the intermediate(s) from the same fullchain so iOS can build the path to the trusted root.
    return execFileSync(
      'openssl',
      ['smime', '-sign', '-signer', cert, '-inkey', key, '-certfile', cert, '-outform', 'DER', '-nodetach', '-md', 'sha256'],
      { input: plist, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (e) {
    // The env vars ARE set but signing FAILED (no openssl, or an unreadable/bad cert). Don't fail
    // silently — otherwise the profile serves 'Unsigned' forever with no clue why. Log it loudly.
    log.error(
      '[install] iOS .mobileconfig signing FAILED — serving UNSIGNED. Verify IOS_PROFILE_SIGN_CERT/KEY ' +
        'point at a readable, publicly-trusted (Let\'s Encrypt) fullchain+key and that openssl is installed.',
      e,
    );
    return null; // serve unsigned (still installs, with the warning)
  }
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
  app.get('/api/install/ios.mobileconfig', async (req, reply) => {
    // Real public origin (nginx forwards Host + X-Forwarded-Proto). Fall back sanely for local dev.
    const proto = (typeof req.headers['x-forwarded-proto'] === 'string' && req.headers['x-forwarded-proto']) || req.protocol || 'https';
    const host = req.headers.host || 'localhost';
    const profile = buildWebClipProfile(`${proto}://${host}/`);
    // Sign it (CMS/DER) when a cert is wired → iOS shows "Verified", no warning; else serve the
    // plain XML profile (still installs, with an "Unsigned" note until the cert is configured).
    const signed = signProfile(profile);
    // The Content-Type is what makes Safari recognise it as a configuration profile (→ Settings → Install).
    reply
      .header('Content-Type', signed ? 'application/x-apple-aspen-config' : 'application/x-apple-aspen-config; charset=utf-8')
      .header('Cache-Control', 'no-store');
    return reply.send(signed ?? profile);
  });
}
