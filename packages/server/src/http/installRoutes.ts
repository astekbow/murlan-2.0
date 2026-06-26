// ============================================================================
// MURLAN — iOS install profile (Web Clip)
// ----------------------------------------------------------------------------
// Serves a .mobileconfig that, opened in Safari, downloads → Settings shows
// "Profile Downloaded" → Install → a full-screen "Crypto-Murlan" home-screen icon
// (landscape via the manifest + the in-app rotate lock). Built DYNAMICALLY from the
// request origin, so it always points at whatever domain it's served from — no
// hard-coded URL, works on prod/staging alike. Public (no auth): it carries no secrets.
// ============================================================================

import type { FastifyInstance } from 'fastify';
import { WEBCLIP_ICON_B64 } from './iosWebClipIcon.ts';

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    // The Content-Type is what makes Safari recognise it as a configuration profile (→ Settings → Install).
    return reply
      .header('Content-Type', 'application/x-apple-aspen-config; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(profile);
  });
}
