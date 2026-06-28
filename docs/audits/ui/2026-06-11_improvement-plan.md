# Crypto-Murlan — Improvement Plan

> Stack: monorepo — `packages/engine` (pure rules), `packages/shared` (DTOs/events), `packages/server`
> (Fastify + Socket.IO + Prisma/Postgres), `packages/client` (React 18 + Vite + Tailwind + Zustand).
> Single-host Docker deploy. Real-money (crypto deposits/withdrawals). PWA.
>
> A large UI redesign was just shipped (obsidian/gold palette, design tokens, reusable `components/ui/*`,
> mobile safe-area, page transitions, skeletons, premium "moments"). This plan is **forward-looking** —
> it does not re-recommend what's already done. Every item lists the concrete problem, the fix, a
> **Priority** (High/Med/Low) and an **Effort** (Small/Med/Large).

## 1. Current State

**What it does today.** A real-time, real-money multiplayer Albanian card game (Murlan). Flow: auth →
lobby (4 mode cards: Quick / Tournaments / Ranked / Open-Rooms) → room → landscape game table.
Surrounding systems: tournaments (single-elim, escrow), leaderboards (global XP + ranked MMR), cosmetic
shop (felt/card-back, XP-only), friends + private clubs + chat, VIP/rake-back, wallet (NOWPayments
crypto), responsible-gaming (self-exclude, reality-check), and an admin panel. State lives in Zustand
stores; gameplay runs over a single Socket.IO connection; views switch via `uiStore.view` (no URL router).

**Main weaknesses found in the code:**
- **No URL routing / deep-linking.** `App.tsx` selects views from `uiStore.view`; query params are
  stripped on load (`App.tsx:91`). Back button doesn't work, refresh always lands on lobby, rooms /
  tournaments / profiles aren't shareable. Only `?replay=`, `?resetPassword=`, `?verifyEmail=` are URL state.
- **Admin UI exposes ~40% of the backend.** `adminRoutes.ts` already serves support tickets, audit log,
  account-state (freeze/suspend/ban), per-user transactions, chat-moderation/mute — **none have UI**
  (`AdminView.tsx`).
- **Destructive/financial actions lack confirmation** (withdraw, self-exclude, leave club, block user,
  cancel tournament, admin credit/debit/role/withdrawal).
- **Desktop wastes space** — every secondary view is a single narrow column inside `max-w-[1180px]`.
- **Accessibility gaps** — no live regions for game events, form errors not linked to inputs, no page
  landmarks, no `aria-current` on nav.
- **Compliance gates are OFF** (per `AUDIT_2026-06-08.md` C1) — a legal blocker for real-money at scale.
- **Near-zero client tests** (9 client test files; no component/store/socket tests).

---

## 2. Mobile (iOS & Android)

Already solid (recent work): safe-area on every screen, haptics (Android), PWA manifest + service
worker, landscape-only game with rotate prompt, 16px inputs (no iOS zoom), `overscroll-behavior:none`,
reduced-motion. Remaining:

| # | Problem (in code) | Fix | Priority | Effort |
|---|---|---|---|---|
| 2.1 | Android hardware back-button closes the PWA mid-game — no `popstate`/back handler anywhere; in standalone fullscreen the OS back gesture exits the app. | Intercept back to (a) close any open modal/sheet, (b) prompt before leaving an active table, (c) otherwise navigate within the app (ties into URL routing, §6). | High | Medium |
| 2.2 | Mobile sub-page nav is weak — the bottom tab bar was removed; the lobby's `RailNav` is the only nav and wraps awkwardly; sub-pages reachable only via TopBar/rail. | A clean, owner-approved mobile nav (compact horizontal nav-chip strip under the lobby header, or a refined bottom bar) — decide together. | Medium | Medium |
| 2.3 | Manifest icon is SVG-only (`manifest.webmanifest`); older Android/iOS render the home-screen icon poorly. | Add 192/512 PNG icons (maskable + any). | Medium | Small |
| 2.4 | Push-notification deep-links aren't validated (`sw.js` opens the payload URL) — a notification for a finished room can 404. | Validate/resolve the target, fall back to lobby. | Medium | Small |
| 2.5 | No offline / last-known state — a socket drop mid-action leaves a blank/stale UI; Wallet blocks on the API. | Cache last balance + room snapshot; show "last known" + a reconnect banner. | Medium | Medium |
| 2.6 | iOS has no Web Push / Vibration — engagement + haptics silently absent on iPhone. | Accept for now; revisit iOS 16.4+ Web Push (installed PWA) later. | Low | Medium |

---

## 3. Desktop

| # | Problem (in code) | Fix | Priority | Effort |
|---|---|---|---|---|
| 3.1 | Wasted horizontal space — `Shell` is `max-w-[1180px]` and Wallet/Shop/Leaderboard/Friends are single-column; on a wide monitor content sits in a ~600px ribbon. | Responsive multi-column at `lg:` — Wallet `[balance + history] \| [deposit/withdraw/limits]`, Shop `[live preview] \| [item groups]`, Leaderboard `[podium] \| [table]` (or Global/Ranked side-by-side), Friends `[add + outgoing] \| [incoming + list]`. | Medium | Medium |
| 3.2 | Interactive rows have no hover state (Shop, Leaderboard, Friends, Clubs members, Tournament matches) — only the lobby rooms + club list do (`hover:border-gold`). | Shared row-hover (`hover:border-gold hover:bg-gold-04`). | Medium | Small |
| 3.3 | No keyboard shortcuts; some modal forms don't submit on Enter (Quick-match / Create-room stake inputs `LobbyView`, Support form). | Enter-to-submit on all single-action forms; a small global set (Esc closes any overlay, `?` opens shortcut help). | Low | Medium |
| 3.4 | Focus not trapped in two overlays — TopBar settings menu (`TopBar.tsx:131`) and `NotificationsPanel` don't use `useFocusTrap` (modals do). | Reuse `useFocusTrap`. | Medium | Small |

---

## 4. Admin Panel

The backend (`adminRoutes.ts`, `adminAudit.ts`, `accountStateService.ts`, `supportRoutes.ts`) is far
richer than the UI (`AdminView.tsx`). **Highest-leverage area.**

| # | Problem (in code) | Fix | Priority | Effort |
|---|---|---|---|---|
| 4.1 | No Support-ticket triage UI — `GET /api/admin/support` + `/resolve` exist; admins can't see/resolve disputes in-app. | "Support" tab — list by status/category, show user + match ref + message, resolve with note. | High | Medium |
| 4.2 | No account-state controls — `POST /admin/users/:id/account-state` (freeze/suspend/ban + reason + duration) has no UI. | Per-user state modal with reason + (suspend) duration, confirmed. | High | Medium |
| 4.3 | No audit-log view — `GET /api/admin/audit` (immutable who-did-what) is never called; a compliance gap. | "Audit Log" tab with filters (admin, action, target, date). | High | Medium |
| 4.4 | No per-user transaction ledger — `GET /admin/users/:id/transactions` unused; can't trace deposit→play→withdrawal. | "Transactions" drawer per user. | High | Medium |
| 4.5 | Withdrawal queue lacks context + safety — `AdminView.tsx:137-152` shows only amount+destination; no username, timestamp, KYC, prior-count; approve/reject instant; reject has no reason (`adminRoutes.ts:187`). | Enrich the DTO (user, createdAt, kyc, priorCount); add confirmation + a reject-reason (audited + user-notified). | High | Medium |
| 4.6 | User list — no pagination/filter/sort — `AdminView.tsx:190` renders every user; search is client-side `.includes` only. | Server-side `?limit/offset` + filters (role, KYC, account-state, balance range, date) + sort. | High | Medium |
| 4.7 | No confirmations / bounds on financial actions — credit/debit/KYC/role (`AdminView.tsx:38,46,73`). | Confirm dialogs (esp. > $100, role, withdrawal) + input min/max. | High | Small |
| 4.8 | No chat-moderation UI — `GET /admin/chat-reports`, mute/unmute exist, no UI. | "Moderation" tab — flagged messages, mute/unmute. | Medium | Medium |
| 4.9 | Active-match list is view-only — can't cancel/void a suspected-collusion match. | Add an admin cancel/refund endpoint + UI (with reason). | Medium | Large |
| 4.10 | Revenue is a single number. | Breakdown by day/match-type + payout liability. | Medium | Medium |
| 4.11 | Single `admin` boolean role (`schema.prisma`). | Role granularity (support_agent / withdrawal_approver / compliance / audit_readonly) gating routes. | Medium | Large |
| 4.12 | No alerting on high-value withdrawals; no bulk actions. | Poll/socket alert for large pending withdrawals; checkbox bulk KYC/state. | Low | Medium |

---

## 5. Buttons & UX Logic

| # | Problem (in code) | Fix | Priority | Effort |
|---|---|---|---|---|
| 5.1 | Destructive/financial actions without confirmation — Withdraw `WalletView.tsx:179`, Self-exclude `:205`, Remove RG limit `:302`, Leave club `ClubsView.tsx:69`, Block user `FriendsView.tsx:162` (styled ghost not danger), Cancel tournament `TournamentsView.tsx:94`, all admin money actions (§4); Leave-table only confirms mid-match, not finished (`TableView.tsx:263`). | A reusable `ConfirmDialog` for every irreversible/money action; make truly destructive buttons `.btn-danger`. | High | Medium |
| 5.2 | Inconsistent async feedback — `.btn-loading` (spinner) exists but rarely used; most buttons only swap label text; some (self-exclude, RG-limit saves, shop buy/equip) show no disabled/spinner. | Standardize `loading` + `disabled` on every async button. | Medium | Small |
| 5.3 | Inconsistent labels/affordance — "Enter" (lobby) vs "Join" (clubs/shop) for the same intent; Buy and Equip both `.btn-gold` though one spends money. | A label convention; Buy=`btn-gold`, Equip=`btn-outline`. | Medium | Small |
| 5.4 | Icon-only buttons / hardcoded labels — seat "view profile" has `title` but no `aria-label` (`TableView.tsx:312`); modal close uses hardcoded `aria-label="Mbyll"` (`Modal.tsx:37`). | Add `aria-label`s; route through `t()`. | Medium | Small |
| 5.5 | Row hover affordance (shared with §3.2). | Shared interactive-row hover. | Medium | Small |
| 5.6 | No account-deletion / data-export path (responsible-gaming + GDPR). | Add to Settings with confirmation + cooling-off. | Medium | Medium |

---

## 6. Next Level

| # | Problem (in code) | Fix | Priority | Effort |
|---|---|---|---|---|
| 6.1 | No URL routing / deep-linking — state-based views block back-button, refresh-persistence, shareable links. | Adopt a router (React Router / TanStack) → `/wallet`, `/leaderboard`, `/room/:id`, `/u/:id`, `/t/:id`; shareable "join my $5 game" invites; keep `?replay=`. Unlocks much of §2/§5. | High | Large |
| 6.2 | Accessibility to AA — no live regions for turn/play/win/switch; form errors not linked (`aria-invalid`/`aria-describedby`); no `<main>/<nav>` landmarks; no `aria-current` nav. | A visually-hidden `aria-live` game-event announcer; wire field errors; add landmarks + `aria-current`. | High | Medium |
| 6.3 | **Compliance & responsible gaming (legal prerequisite)** — KYC/AML/geo/age gates are OFF; no loss limits or session timers. | **Business + legal, not just code:** obtain the gambling licence(s) for target markets, then enable KYC/AML + geo/age gates, daily/weekly loss limits, session reminders, RG message on cash-out. **Do not scale real-money play until done.** | Critical | Large |
| 6.4 | Performance — `TableView` re-renders the whole hand on each play; `CardView`/`Hand`/seat not memoized; `TurnTimer` uses a 100ms `setInterval`; Google fonts add ~50KB; socket reconnect is infinite 500ms retries (no backoff). | `React.memo` the card/seat components; drive the timer with CSS/rAF; self-host/subset fonts; exponential socket backoff. | Medium | Medium |
| 6.5 | i18n completeness — sq is source, en partial; `TableView`/`Scoreboard`/log keep Albanian literals. | Finish EN, remove literals, key everything. | Medium | Medium |
| 6.6 | Client testing — only 9 client tests, none for components/stores/socket. | `@testing-library/react` + Vitest for stores, `TableView`, a11y, money flows. | Medium | Large |
| 6.7 | Observability — server has Prometheus; client has no error tracking/analytics. | Sentry (private sourcemaps), Web Vitals, socket-latency percentiles, opt-in support log capture. | Medium | Medium |
| 6.8 | Onboarding + presence — no tutorial/rules; no "who's online" though `Presence` exists. | 3-step tutorial (rules → practice bot → go live); presence badges; spectator count on the table. | Medium | Medium |

---

## Recommended Implementation Order (quick wins first)

1. **Quick wins** (Small effort, mostly High value): confirmations on every destructive/financial action
   (§5.1/§4.7) · consistent `.btn-loading`+disabled (§5.2) · row hover states (§3.2/§5.5) ·
   `aria-label`/i18n on icon buttons (§5.4) · focus-trap the TopBar menu + Notifications (§3.4) · admin
   financial confirmations + input bounds (§4.7) · withdrawal reject-reason (§4.5) · PNG app icons (§2.3)
   · Enter-to-submit in modal forms (§3.3).
2. **Admin depth** (Medium, High value): Support-tickets tab (§4.1) · account-state controls (§4.2) ·
   audit-log tab (§4.3) · per-user transaction ledger (§4.4) · enriched withdrawal queue (§4.5) · user
   pagination/filter/sort (§4.6).
3. **Desktop + accessibility** (Medium): multi-column Wallet/Shop/Leaderboard/Friends (§3.1) ·
   game-event `aria-live` announcer + form-error wiring + landmarks/`aria-current` (§6.2).
4. **URL routing + deep-linking** (Large, High): unblocks back-button, refresh, shareable
   rooms/tournaments/profiles, and the Android back-button fix (§6.1, §2.1).
5. **Compliance & responsible gaming** (Critical, Large — business + legal): licensing, then turn the
   KYC/AML/geo/age gates ON + loss limits + session timers **before scaling real-money** (§6.3).
6. **Platform depth** (Medium/Large): i18n completeness (§6.5) · client test suite (§6.6) ·
   Sentry/observability (§6.7) · perf memoization + socket backoff (§6.4) · onboarding/tutorial +
   presence (§6.8) · admin chat-moderation (§4.8), match-void (§4.9), role granularity (§4.11), revenue
   breakdown (§4.10).
