# UPGRADE PROMPT — Take "Murlan Online" to next level

You are an expert game‑UI engineer. The Murlan web app already works (auth, lobby, rooms, real‑money wallet, authoritative Socket.IO server, and a **tested rules engine** in `engine.ts`). Your job now is a **major polish + engagement pass** that makes it look and feel like a premium, living card‑game product — not a flat web form.

A visual target is provided: **`murlan-mockup-v2.html`** (open it). Match its *quality and aesthetic* (premium card‑club: deep maroon/black, ornate glowing gold table rail, warm red felt with a faint suit‑pattern, gold display type, depth, sparkle, smooth motion). Do **not** copy it pixel‑for‑pixel and do **not** copy any third‑party game's icons or art — use it as the north star and do it cleanly.

## Hard rules (do not break)
- **Do NOT touch the rules engine, game state machine, scoring, or money/ledger logic.** This pass is *additive and visual*. If a change needs server support, add a new endpoint/event — never rewrite the authoritative game or balance code.
- **This is a real‑money app (USD via crypto/PayPal).** Do **NOT** introduce a fake coin/gem economy or "daily cash bonus" like free‑to‑play games — free credit redeemable for cash is regulated gambling promotion. Engagement rewards must be **cosmetic or XP only** (see §2.6) and clearly non‑cashable. Keep the `$` balance exactly as it is.
- **Mobile‑first.** Everything must look and play great on a phone, including the table in landscape. No layout shift, target 60fps, no jank.
- Work in **phases** (below); after each, show me the result and the build running before continuing. Keep components modular and reusable.

---

## PART 1 — Visual overhaul

### 1.1 Design system (do this first)
Create a single source of truth in `client` (CSS variables + Tailwind theme extension) extracted from the mockup:
- **Palette:** background maroon‑to‑black gradient; felt red (`--felt`) with darker edge; **ornate gold** rail/accents (`--gold`, `--gold-hi`, `--gold-deep`), warm bulb glow; cream card faces; suit red; muted warm text. Player‑ring colors: blue (idle), green (active/last‑played), gold (your turn).
- **Typography:** load from Google Fonts — a bold condensed display (e.g. **Oswald**) for game titles/labels with a gold gradient + subtle dark stroke, an ornate serif (**Cinzel**) for crests/headers, and a clean body font (**Outfit**). No system fonts, no Inter.
- **Depth & atmosphere (this is what kills the "flat" look):** layered radial gradients, a faint tiled suit‑pattern watermark, a subtle grain overlay, a vignette, soft sparkles, and rich multi‑layer shadows. Every panel = glassy fill + 1px gold top‑highlight + drop shadow.
- **Components:** gold/green pill buttons (hover lift), glass panels with gold trim, styled inputs/selects, status tags (`Hapur` / `Po luhet`), avatar with level ring + XP bar, balance chip with coin + “＋”, round icon buttons. Reuse everywhere.
- **Motion:** staggered page‑load reveals (animation‑delay), hover micro‑interactions, a rotating turn‑timer ring, twinkling rail bulbs. Use CSS where possible; a small animation lib (Motion/Framer) for React transitions is fine.

### 1.2 Top bar (every screen)
Profile (avatar + level badge + XP bar + username), the **$ balance chip** with a coin and a “＋” that opens the wallet, plus notification and settings icon buttons. Gold display type for the brand.

### 1.3 Main menu / lobby
- A lavish **hero with two mode cards** (like the mockup): e.g. **“Lojë e Shpejtë”** (quick‑match → pick 1v1 / 1v1v1 / 2v2 + stake) and **“Turne / Dhomat”** (browse/create staked rooms). Each card has depth, a subtle card motif, glow on hover, and a gold CTA.
- A **side rail** of round icons: **Klasifikimi** (leaderboard), **Miqtë** (friends), **Sfidat** (challenges/XP), **Dyqani** (cosmetics). Badges for unread/claimable.
- An **“Dhomat e hapura”** list styled as rich rows: type, stake, `filled/total` players, `Hapur`/`Po luhet` tag, and `Hyr`/`Shiko`. Friendly empty state (never a dead blank).
- A **“Krijo dhomë”** flow: type select + stake input (with `$`), styled like the mockup.

### 1.4 Matchmaking screen
When joining quick‑match, show a polished waiting screen (crest, the list of joined players with avatars filling in, a **“Loja fillon për {n}s”** countdown, and a SOLO/2V2 context tag) before the table loads.

### 1.5 The game table (the centerpiece)
Rebuild the table view to match the mockup:
- **Ornate gold rail** wrapping a **red felt** with the faint suit watermark; **glowing bulbs** spaced around the rail.
- **Seat layout by room type:** 1v1 = you bottom + opponent top; 1v1v1 = you bottom + two top corners; 2v2 = you bottom, **partner top**, opponents left/right (teammates opposite, team color‑coded). Each opponent = avatar with colored ring, name, **card‑count badge**, and a face‑down **mini card fan** sized to their count.
- **Your turn:** gold ring + rotating timer arc on the active player. **“Hodhi i fundit” / Last‑played** badge on the last player who led.
- **Center pile:** the current combo rendered as real overlapping cards.
- **Your hand:** big, crisp, readable cards (rank + suit clearly legible like the reference), fanned along the bottom; **tap to select** (cards lift; selected get a gold outline), with **Pas** / **Luaj** buttons. Disable illegal selections using `engine.validatePlay` for instant feedback (server still authoritative).
- **Corner controls:** menu/list, chat, and emote buttons.
- **Scoreboard:** cumulative points; for 2v2 show **Skuadra 1 / Skuadra 2** totals; show current target T (21 → 31 …).

---

## PART 2 — "Next level" features (make it alive)

### 2.1 Animations & game feel
Deal animation (cards fly from deck to hands), play animation (selected cards slide to the pile), trick‑collect sweep, a **win/round‑over celebration** (confetti/gold burst + result panel with placements and points), balance **count‑up** on payout, smooth screen transitions, button/tap feedback. Subtle but polished.

### 2.2 Sound & music
A small audio system with: background lobby music, table ambience, and SFX (deal, card play, pass, your‑turn ping, win, button). Mute/volume toggle in settings, remembered per device (in‑memory/state for artifacts; for the real app use a settings record).

### 2.3 Player profiles & progression
Avatars (choose from a set or upload), **levels + XP** (earn XP for playing/winning — XP only, never cash), and stats: games played, wins, win‑rate, biggest pot, current streak. A profile modal reachable from the top bar and from any seat (tap an opponent to view their public profile).

### 2.4 Leaderboard
Global and weekly boards (by XP/wins/win‑rate). Polished rows with rank, avatar, and the viewer’s own rank highlighted.

### 2.5 Friends & social
Add/accept friends, see who’s online, and **invite a friend to a room**. In‑game **emotes** (a quick wheel) and a **quick‑chat** with preset phrases (full free chat optional, moderated). These are in the mockup’s corner icons.

### 2.6 Engagement rewards (cosmetic/XP only — compliance‑safe)
A **daily login** and **challenges** system that grants **XP and cosmetics only** (card backs, table felt themes, avatar frames) — never cashable credit. A **Dyqani** for cosmetics; you may let users buy cosmetics with their `$` balance, but cosmetics must be non‑refundable and clearly separate from wagering. Add a visible toggle/flag so all rewards can be disabled per‑jurisdiction.

### 2.7 Notifications & toasts
A toast system (your turn, you won, friend online, deposit confirmed, error) and a notifications panel behind the bell.

### 2.8 Robustness UX
Polished loading skeletons, a reconnect overlay (“Po rilidhemi…”) that restores table state, graceful empty/error states, and clear handling when an opponent disconnects/abandons (surface the server’s existing forfeit/settlement outcome — don’t invent new money rules).

---

## PART 3 — Quality bar
- 60fps interactions; no cumulative layout shift; lazy‑load heavy assets; preload fonts.
- Accessible: focus states, adequate contrast, keyboard play for hand/buttons, `prefers-reduced-motion` respected.
- Asset strategy: use clean CSS/SVG placeholders now (as in the mockup); structure so real illustrated art (avatars, mode art, crests) can drop in later without refactors. **Do not** use copyrighted/third‑party game art.
- Keep Albanian UI text throughout. Keep everything responsive (phone → desktop).

---

## Build order (phases — show me each before moving on)
1. **Design system** — palette, fonts, textures, base components, top bar. Reskin existing screens to remove the flat look.
2. **Lobby + matchmaking** — hero mode cards, side rail, rich room list, create‑room, waiting screen.
3. **Table visual rebuild** — ornate rail + felt + bulbs, seats by room type, hand/pile/cards, turn ring, scoreboard, corner controls.
4. **Game feel** — deal/play/win animations, count‑up, transitions, sound system.
5. **Profiles, XP, leaderboard, friends, emotes/chat.**
6. **Cosmetic rewards (daily/challenges/shop), notifications, reconnect/empty/error UX.**
7. **Polish & QA** — performance, accessibility, mobile passes.

**Constraints recap:** additive only; never modify the rules engine, game/scoring logic, or money/ledger; real‑money model stays (no fake coins, no cashable bonuses); cosmetic/XP rewards only with a per‑jurisdiction off switch. **Start with Phase 1**, reskinning from `murlan-mockup-v2.html`, and show me the result.
