# Mobile Responsive Audit — Crypto-Murlan (2026-06)

Full responsive audit + repair of the client. Goal: pixel-locked, no rotation-zoom, no
input-zoom, no horizontal scroll, no layout shift, across the iPhone + Android matrix in
both orientations.

## Harness (Phase 0)

- `mobile-audit/screenshot.cjs` — Playwright. Loads the app on 11 device profiles ×
  {portrait, landscape}, screenshots to `shots/`, and runs a DOM probe for: horizontal
  overflow, sub-16px input fonts, and <44px touch targets. Writes `probe-report.json`.
- Run it: `URL=http://localhost:5173 node mobile-audit/screenshot.cjs` (dev server up).
- **Reach limitation:** the dev server is wired to the **live Supabase DB**, so to avoid
  writing test data I only rendered the **login screen** (read-only). The lobby/table need
  an authenticated user + a live multiplayer match, which the harness can't safely create.
  Those screens were audited via **code** + the owner's on-device screenshots. The fixes
  below are **global CSS**, so they apply to every screen regardless.

## Findings + fixes

### 1 — Zoom on rotation · **High** · Cat A (viewport/zoom)
- **Where:** `packages/client/src/index.css` — no `text-size-adjust` rule existed anywhere.
  Showed on every device when rotating.
- **Root cause:** mobile browsers auto-inflate ("text boosting") font sizes when the
  viewport widens on rotation. The viewport meta was already correct
  (`width=device-width, initial-scale=1, viewport-fit=cover`), so the meta was *not* the
  cause — the browser heuristic was.
- **Fix:** `html { -webkit-text-size-adjust:100%; text-size-adjust:100%; }` — disables the
  heuristic; real pinch-zoom is untouched.
- **Status:** Fixed ✅

### 2 — iOS zooms when focusing an input · **High** · Cat A
- **Where:** `index.css` `.field` base `font-size:14px`; the 16px fix lived **only** inside
  `@media (max-width:480px)`. So **landscape (>480px) + tablets** rendered 14px inputs.
- **Evidence:** probe — `smallInput=2` in landscape, `0` in portrait (both `.field` @14px).
- **Root cause:** iOS Safari force-zooms when a focused input's font-size is < 16px; the
  fix was gated on width, missing landscape/tablet.
- **Fix:** `.field { font-size:16px }` at the **base** (removed the width-gated override).
- **Status:** Fixed ✅ — probe now `smallInput=0` on all 22 device/orientation combos.

### 3 — Layout shifts between screens · **Medium** · Cat C
- **Where:** `index.css` `html` — no `scrollbar-gutter`.
- **Root cause:** when one route scrolls (scrollbar present) and another doesn't, the page
  content width changes → horizontal jump on navigation. (Desktop / any platform with
  classic scrollbars; no-op on mobile overlay scrollbars.)
- **Fix:** `html { scrollbar-gutter: stable; }`.
- **Status:** Fixed ✅

### 4 — No horizontal-overflow guard · **Medium** · Cat B
- **Where:** `index.css` `html, body` — no `overflow-x` clamp; `body` had no
  `overflow-wrap`.
- **Root cause:** any single over-wide element forces a horizontal scroll AND a rotation
  rescale. The login screen probes clean, but the owner reports h-scroll on a screen the
  harness can't reach (lobby/table).
- **Fix:** `html, body { overflow-x: clip; }` (clip, not hidden → no new scroll container,
  doesn't break sticky; inner scrollers like the hand fan are unaffected) +
  `body { overflow-wrap: break-word; }` (long usernames/chat/URLs can't blow out width).
- **Status:** Fixed ✅ (root-cause prevention for text/width) + ⚠️ `overflow-x:clip` is a
  **flagged safety net** — see "Open items".

### 5 — Near-miss touch targets · **Medium** · Cat F
- **Where:** probe (touch, landscape) — `.seg-tab` ~42px, `.field` ~43px.
- **Root cause:** padding 1–2px short of the 44px WCAG 2.5.5 minimum.
- **Fix:** in `@media (hover:none)`: `.seg-tab { min-height:44px }`, `.field { min-height:44px }`.
- **Status:** Fixed ✅ — probe `tinyTap` 3/5 → 1 (the 1 remaining is an inline text link).

### 6 — `100vw` in NotificationsPanel · **Low** · Cat A
- **Where:** `components/ui/NotificationsPanel.tsx:61` — `max-w-[calc(100vw-1.5rem)]`.
- **Root cause:** `100vw` ignores the scrollbar; can overshoot by the scrollbar width on
  desktop. On mobile (overlay scrollbars) it's a no-op, and it's a `max-width` cap (not a
  width), so it can't itself cause overflow.
- **Status:** Not changed (Low; left as a known minor — see "Open items").

## Before / after (probe across the matrix, both orientations)

| Symptom | Before | After |
|---|---|---|
| Inputs < 16px (iOS focus-zoom) | 2 per device **in landscape** | **0** on all 11 devices × 2 orientations |
| Horizontal overflow / h-scroll (login) | 0 | 0 (no regression) |
| Touch targets < 44px | 3 portrait / 5 landscape | 1 (an inline text link, exempt) |
| Rotation text-boost zoom | active (no guard) | disabled at root |
| Route width shift | possible | gutter reserved |

Device profiles exercised: iPhone SE, 12 Mini, 13, 14 Pro, 14 Pro Max, 15 Pro Max,
Pixel 7, Galaxy S9+, Android-360 baseline, Android-412, Foldable-folded-280 — each
portrait + landscape. Screenshots in `mobile-audit/shots/`.

## Already correct (verified, no change)
- Viewport meta is ideal (`width=device-width, initial-scale=1, viewport-fit=cover`).
- `.app-shell` has full safe-area padding (top/bottom/left/right).
- `@media (hover:none)` already bumps `.iconbtn`/`.btn`/`.tcorner` to 44px.
- The game table uses `100dvh` (not `100vh`) → no address-bar cutoff.
- Pinch-zoom is **not** locked (`user-scalable=no` is absent) — good for low-vision users.

## Accessibility trade-offs
- **None that reduce access.** We did **not** add `user-scalable=no` / `maximum-scale=1`
  (would disable pinch-zoom) — the rotation-zoom was fixed at the real root
  (`text-size-adjust`), so the accessibility-hostile lock was unnecessary.
- `overflow-x: clip` is the only "defensive" change; it can't hide vertical content and
  doesn't trap focus — it only prevents sideways scroll.

## Open items / intentionally NOT changed
- **`overflow-x:clip` is a safety net, not a located root cause.** The harness couldn't
  reach the lobby/table (live-DB constraint), so a specific over-wide element on those
  screens — if one exists on the owner's phone — was not pinpointed. Next step: run the
  harness against a **staging** backend (or have the owner screenshot the exact
  horizontally-scrolling screen) to find and fix the real culprit, then the clip becomes
  pure belt-and-suspenders.
- **`100vw` in NotificationsPanel** (#6) — Low; left as-is.
- **In-game table seat/card layout** — handled separately (proportional timer ring,
  top-bar safe-area, bigger cards, top-seat reposition) in prior commits; still benefits
  from on-device iteration.
- **`playwright`** was added to devDependencies so the harness is runnable; remove it if
  you don't want the browser-test dep in the repo (the harness needs it + `npx playwright
  install chromium`).
