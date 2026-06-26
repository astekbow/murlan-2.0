// Regenerates the PWA / favicon / iOS-clip icons from the BRAND LOGO at
// foto/cryptomurlan logo new.svg using headless Chromium (Playwright renders the SVG's masks/filters
// perfectly). Re-run after the logo changes:  node packages/client/scripts/gen-icons.mjs
//
// The logo is a COMPLETE square app-icon (black ♠ + red glow on its own dark radial background) so it's
// rendered FULL-BLEED — no extra tile/padding. The black backstop covers any rounded-corner transparency
// (matches the logo's dark corners; maskable-safe — the OS just crops the square).
//
// Output (packages/client/public/):
//   icon-192.png / icon-512.png  → PWA install, Android & iOS home-screen, notification icon
//   favicon.png                  → browser tab
//   logo.svg                     → the raw logo, served for in-app brand use
// After running, regenerate the embedded iOS-clip base64 (server reads icon-192.png) — see
// packages/server/src/http/iosWebClipIcon.ts (base64 of icon-192.png).
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');               // repo root
const SVG_PATH = join(ROOT, 'foto', 'cryptomurlan logo new.svg');
const PUBLIC = join(HERE, '..', 'public');
const SVG = readFileSync(SVG_PATH, 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });

async function render({ size, file }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent}
    #tile{width:${size}px;height:${size}px;overflow:hidden;background:#000;
          display:flex;align-items:center;justify-content:center;box-sizing:border-box}
    #logo{width:100%;height:100%}
    #logo svg{width:100%;height:100%;display:block}
  </style></head><body><div id="tile"><div id="logo">${SVG}</div></div></body></html>`;
  await page.setContent(html, { waitUntil: 'networkidle' });
  const buf = await (await page.$('#tile')).screenshot();
  writeFileSync(join(PUBLIC, file), buf);
  console.log(`wrote ${file} (${buf.length} bytes)`);
}

await render({ size: 512, file: 'icon-512.png' });
await render({ size: 192, file: 'icon-192.png' });
await render({ size: 128, file: 'favicon.png' });
copyFileSync(SVG_PATH, join(PUBLIC, 'logo.svg'));
console.log('copied logo.svg');

await browser.close();
