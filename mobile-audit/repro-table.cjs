// Screenshot the table-layout repro (repro-table.html) at short landscape sizes to verify
// the top bar + felt + hand fit 100dvh with the corner buttons visible.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const FILE = 'file://' + path.join(__dirname, 'repro-table.html').replace(/\\/g, '/');

// Inject the LATEST built stylesheet (its filename is content-hashed, so resolve it at
// runtime instead of hardcoding the hash in the HTML).
const ASSETS = path.join(__dirname, '..', 'packages', 'client', 'dist', 'assets');
const CSS = fs.existsSync(ASSETS)
  ? path.join(ASSETS, fs.readdirSync(ASSETS).find((f) => /^index-.*\.css$/.test(f)))
  : null;

const SIZES = [
  { name: 'iPhone-14-Pro-Max-LS', w: 932, h: 430 },
  { name: 'iPhone-XR-LS', w: 896, h: 414 },
  { name: 'iPhone-12-Pro-LS', w: 844, h: 390 },
  { name: 'Android-360-LS', w: 640, h: 360 },
  { name: 'iPhone-SE-LS', w: 667, h: 375 },
];

(async () => {
  const browser = await chromium.launch();
  for (const s of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(FILE, { waitUntil: 'networkidle' });
    if (CSS) await page.addStyleTag({ path: CSS });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `repro-${s.name}.png`) });
    // Does the top bar's bottom sit ABOVE the felt's top? (no cover) + is the whole bar on-screen?
    const probe = await page.evaluate(() => {
      const top = document.querySelector('.tv-top').getBoundingClientRect();
      const felt = document.querySelector('.rail-inner').getBoundingClientRect();
      const hand = document.querySelector('.tv-bottom').getBoundingClientRect();
      const root = document.querySelector('.tv-root').getBoundingClientRect();
      return {
        topBar: { top: Math.round(top.top), bottom: Math.round(top.bottom) },
        feltTop: Math.round(felt.top),
        feltW: Math.round(felt.width),
        feltH: Math.round(felt.height),
        feltAspect: +(felt.width / felt.height).toFixed(2), // lower = less "stretchy"
        handBottom: Math.round(hand.bottom),
        viewportH: window.innerHeight,
        topBarFullyVisible: top.top >= -0.5 && top.bottom <= window.innerHeight,
        topBarClearOfFelt: top.bottom <= felt.top + 0.5,
        handBottomVisible: hand.bottom <= window.innerHeight + 0.5,
        rootOverflow: Math.round(root.height - window.innerHeight),
      };
    });
    console.log(`${s.name} (${s.w}x${s.h}):`, JSON.stringify(probe));
    await ctx.close();
  }
  await browser.close();
})();
