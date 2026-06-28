# 🖥️ Full UI Audit — every page, card & popup (2026-06)

Read-only audit by 6 parallel agents over **every** view + card + modal/popup, on 3 dimensions:
**scroll** (fits without scroll), **rotation** (survives the new force-landscape CSS rotation), **ux/a11y**.
Each finding carries `file:line` + a concrete fix. Scope note: the app now CSS-rotates the whole UI 90°
on a portrait phone (force-landscape) — that change is the source of most findings here.

> **One thing already fixed during this audit:** all 12 popups/consoles that portaled to `document.body`
> now portal into `#root` (commit `f8928fe`) — otherwise they rendered **upright while the app is rotated**.

---

## 1. The 4 systemic root causes (fix these → most per-screen issues disappear)

The force-landscape rotation is a CSS transform on `#root`. The browser's **media queries + viewport units
still see the PHYSICAL (portrait) viewport** — they don't know the content is visually rotated. That single
fact causes 4 cross-cutting problems:

| # | Root cause | Why it breaks | The CORRECT fix |
|:-:|---|---|---|
| **R1** | `@media (orientation: landscape)` compaction (modals, page consoles, mode cards) **never fires** when a portrait phone is CSS-rotated | the device is *physically* portrait, so the query is false → tall portrait styling shows in the rotated landscape frame | Duplicate each landscape compaction block to **also** apply under `html.force-landscape` (a CLASS, inside `@media (orientation: portrait)`). **NOT** `@media (max-height:600px)` — a rotated portrait phone reports its *physical* height (~844px), so that never matches either. |
| **R2** | `vh` / `dvh` / `svh` units mean the **physical portrait viewport** inside the rotated frame | e.g. `max-h-[60vh]` on a 375-px-wide phone = 60% of 812px = 487px, but the rotated frame is only 375px tall → overflow/scroll | Under `html.force-landscape`, the frame's HEIGHT = `100vw`. Swap height units to **`vw`** (and width units to `vh`). `svh` does **not** help — it's also the physical viewport. |
| **R3** | `useLandscapePage()` / the table's `ls` flag are `(orientation: landscape)`-based → **false** under rotation | secondary pages render their **portrait** layout (stacked/scrollable), which is then rotated → a sideways portrait page instead of the fitted landscape "console" | Make `useLandscapePage` + the table layout switch **true when force-landscape is active** (mobile && portrait), so pages render their landscape console JSX in the rotated frame. |
| **R4** | `createPortal(…, document.body)` escapes the rotated `#root` | popup renders upright while the app is sideways | **✅ FIXED** — all 12 now portal to `#root`. |

> Because of R1–R3, the current full-app rotation will look wrong on iOS until those are done. **Test the
> base rotation on a real iPhone first** (is the direction even right?) before investing in R1–R3 — see §4.

---

## 2. Verdict by screen

🟥 broken · 🟧 minor · 🟩 ok  *(broken = likely unusable under rotation until R1–R3 land)*

### Pages
| Screen | Verdict | Headline issue |
|---|:--:|---|
| AuthView (login/register) | 🟧 | portrait `space-y-5` may overflow on SE; forgot-pw modal safe-area insets don't re-map under rotation; `.field-label` contrast ~5.8:1 |
| **LobbyView** (mode cards, room list, RailNav) | 🟥→🟧 | body-portal **FIXED**; mode cards keep `min-height:174px` under rotation (R1); `.pg-ls-scroll` lacks a max-height cap |
| **RoomView** (waiting room) | 🟥→🟧 | body-portal **FIXED**; portrait stack (~638px) pushes "I'm Ready" below the fold on SE; online-dot is color-only (a11y) |
| WalletView (deposit/withdraw/history) | 🟩/🟧 | deposit OK; history filter chips + rotation handling minor |
| ShopView | 🟧 | item rarity styling minor; landscape OK |
| RewardsView (VIP/quests/challenges) | 🟧 | unearned-achievement + progress-bar states minor; landscape OK |
| FriendsView | 🟧 | long lists; online-status dot color-only + tiny (a11y) |
| ClubsView | 🟧 | members/chat stacking; DM modal minor |
| SupportView | 🟧 | the new-ticket `<textarea>` can grow and push the submit button off-screen |
| ReplayView | 🟩 | ok |
| TournamentsView | 🟧 | bracket report buttons ~18px tall (below 44px touch target) |
| **AdminView** | 🟥 | `max-h-[30vh/60vh/70vh]` on user-txns / reports / audit overflow the rotated frame (R2); adjust-row buttons wrap tall on narrow phones; some toggles miss `aria-label` |

### Game
| Screen | Verdict | Headline issue |
|---|:--:|---|
| TableView — landscape canvas | 🟧 | canvas unit-swap (added) covers the main sizing; verify NO other `vw/svh` in `.tv-*` is left un-swapped (R2) |
| TableView — match-end panel | 🟧 | capped + scrollable + compacted (done earlier); compaction relies on R1 firing under rotation |
| TableView — hand / controls / overlays | 🟩 | hand uses JS-measured px (rotation-safe); Pas/Luaj ≥44px; confetti/announcer/emotes ok |
| SpectateView | 🟩 | flow layout, scroll-safe (intentionally not a canvas) |

### Modals / popups / overlays
| Component | Verdict | Headline issue |
|---|:--:|---|
| Modal (base) | 🟧 | `max-h-[88dvh]` = physical portrait height under rotation (R2); landscape compaction doesn't fire (R1) — capped to `92vw` already, padding/gaps still need R1 |
| **TopBar gear menu** | 🟥→🟧 | body-portal **FIXED**; `fixed top-16 right-…` anchors to the rotated frame now (good) |
| **NotificationsPanel** | 🟥→🟧 | body-portal **FIXED**; `max-h-[60vh]` should be frame-relative (R2) |
| ProfileModal | 🟧 | `space-y-4` + 6-col avatar picker too tall/small under rotation (R1); loading/error lack `sr-only` text |
| SettingsModal | 🟧 | session-recap + sliders stack tall; compaction needs R1 |
| OnboardingModal | 🟧 | step dots + 4 buttons stack tall; needs R1 |
| RulesModal · ConfirmDialog · RankedSearchOverlay · ReconnectOverlay · InviteFriendsPanel | 🟩 | ok (tabbed / compact / correctly centered) |

---

## 3. Quick a11y/UX wins (independent of rotation — safe to do anytime)
- **Touch targets <44px:** TournamentsView bracket report buttons (`padding:'3px 8px'` → `btn-sm`); AdminView permission toggles.
- **Color-only status:** the friend/seat **online dot** (RoomView/FriendsView) — add `aria-label={online?'Online':'Offline'}` + a non-color cue.
- **Missing `sr-only`:** ProfileModal loading/error emoji; a few AdminView disclosure toggles need `aria-label`.
- **Contrast:** `.field-label` 12px `--muted-sm` ≈ 5.8:1 — bump to `--muted-sm-hi` or 13px.
- **SupportView textarea:** cap height (`max-h-24` / `resize-none` on phones) so it can't push the submit button off-screen.

---

## 4. Recommended order

1. **✅ Done:** portal-to-`#root` (R4).
2. **🔴 TEST FIRST (you, on iPhone):** is the base force-landscape rotation correct (direction, the game table usable)? Everything below is wasted if the base rotation is wrong. Report what you see.
3. **Then the systemic rotation fixes (R1–R3)** — these are interdependent and need on-device iteration; do them as one focused pass *after* the base is confirmed:
   - R3: `useLandscapePage` + table `ls` → true under force-landscape.
   - R1: landscape compaction blocks → also under `html.force-landscape`.
   - R2: swap `vh/dvh/svh` → `vw` (and `vw`→`vh`) under `html.force-landscape` (Admin&nbsp;`max-h`, NotificationsPanel, Modal padding…).
4. **Quick a11y/UX wins (§3)** — independent of rotation, safe anytime.

> **Honest note:** the full-app CSS rotation is a large, interconnected change that can't be verified without
> a device. If on-device testing shows it's fiddly, the lower-risk alternative is to **rotate only the game
> (table/spectate/match-end)** and keep the lobby/menus in their normal **portrait** layouts (they already
> have working portrait layouts) — most mobile card games do exactly this. Say the word and I'll re-scope.

---
*Generated 2026-06 by a 6-agent read-only audit over every page/card/popup. Only the R4 portal fix was applied; everything else is reported for prioritization.*
