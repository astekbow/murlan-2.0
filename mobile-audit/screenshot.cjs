// Mobile responsive audit harness.
// Screenshots the app across a phone device matrix (portrait + landscape) and runs a
// DOM probe to catch horizontal overflow, sub-16px input fonts, and tiny touch targets.
// Usage:  URL=http://localhost:5173 node mobile-audit/screenshot.js
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.URL || 'http://localhost:5173';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

// Built-in descriptors where available; explicit logical viewports for the rest of the
// matrix (360px Android baseline is the hard minimum we must protect).
const TARGETS = [
  { name: 'iPhone-SE', dev: devices['iPhone SE'] },
  { name: 'iPhone-12-Mini', vp: { width: 375, height: 812 }, dpr: 3 },
  { name: 'iPhone-13', dev: devices['iPhone 13'] },
  { name: 'iPhone-14-Pro', vp: { width: 393, height: 852 }, dpr: 3 },
  { name: 'iPhone-14-Pro-Max', dev: devices['iPhone 14 Pro Max'] },
  { name: 'iPhone-15-Pro-Max', vp: { width: 430, height: 932 }, dpr: 3 },
  { name: 'Pixel-7', dev: devices['Pixel 7'] },
  { name: 'Galaxy-S9plus', dev: devices['Galaxy S9+'] },
  { name: 'Android-360-baseline', vp: { width: 360, height: 640 }, dpr: 3, mobile: true },
  { name: 'Android-412-large', vp: { width: 412, height: 915 }, dpr: 2.6, mobile: true },
  { name: 'Foldable-folded-280', vp: { width: 280, height: 653 }, dpr: 2.5, mobile: true },
];

const PROBE = () => {
  const docW = document.documentElement.clientWidth;
  const out = { docW, scrollW: document.documentElement.scrollWidth, horizontalOverflow: [], tinyTouchTargets: [], smallInputFont: [] };
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width > 0 && (r.right > docW + 1 || r.left < -1)) {
      out.horizontalOverflow.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), left: Math.round(r.left), right: Math.round(r.right), docW });
    }
    if (el.matches('a,button,[role=button],input,select,textarea,[onclick]')) {
      if ((r.width && r.width < 44) || (r.height && r.height < 44)) {
        out.tinyTouchTargets.push({ tag: el.tagName, cls: String(el.className).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    if (el.matches('input,select,textarea')) {
      const fs = parseFloat(cs.fontSize);
      if (fs < 16) out.smallInputFont.push({ cls: String(el.className).slice(0, 40), fontSize: fs });
    }
  });
  // de-dupe overflow by class (same culprit repeated)
  const seen = new Set();
  out.horizontalOverflow = out.horizontalOverflow.filter((o) => { const k = o.tag + o.cls; if (seen.has(k)) return false; seen.add(k); return true; });
  return out;
};

(async () => {
  const browser = await chromium.launch();
  const report = {};
  for (const t of TARGETS) {
    for (const orient of ['portrait', 'landscape']) {
      const base = t.dev ? { ...t.dev } : { viewport: t.vp, deviceScaleFactor: t.dpr ?? 2, isMobile: t.mobile ?? true, hasTouch: true };
      const vp = base.viewport;
      const ctx = await browser.newContext({
        ...base,
        viewport: orient === 'landscape' ? { width: vp.height, height: vp.width } : vp,
      });
      const page = await ctx.newPage();
      const key = `${t.name}-${orient}`;
      try {
        await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `${key}.png`), fullPage: false });
        report[key] = await page.evaluate(PROBE);
      } catch (e) {
        report[key] = { error: String(e).slice(0, 120) };
      }
      await ctx.close();
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'probe-report.json'), JSON.stringify(report, null, 2));
  // Console summary: only devices with any finding.
  for (const [k, r] of Object.entries(report)) {
    if (r.error) { console.log(`${k}: ERROR ${r.error}`); continue; }
    const of = r.horizontalOverflow.length, sf = r.smallInputFont.length, tt = r.tinyTouchTargets.length;
    const hScroll = r.scrollW > r.docW + 1 ? ` H-SCROLL(${r.scrollW}>${r.docW})` : '';
    if (of || sf || tt || hScroll) console.log(`${k}: overflow=${of} smallInput=${sf} tinyTap=${tt}${hScroll}`);
    else console.log(`${k}: clean`);
  }
})();
