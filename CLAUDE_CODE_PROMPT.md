# BUILD PROMPT — "Murlan Online" (real‑money multiplayer card game)

You are an expert full‑stack engineer. Build a **production‑grade, real‑time, multiplayer web application** for the Albanian card game **Murlan**, played for real money via crypto and PayPal. Work in **phases** (defined at the end). After each phase, write tests and confirm they pass before moving on. Ask me before making any assumption that affects money handling or the rules.

A **tested rules engine (`engine.ts`) is already written and provided** — 47 unit tests pass. Treat it as the single source of truth for card logic. Do **not** reinvent combination/comparison logic; import and build around it. The complete rules are also specified below so you fully understand them.

---

## 0. Non‑negotiable principles

1. **Authoritative server.** The server holds the true game state. Clients send *intentions* ("I want to play these cards"); the server validates with `engine.ts` and broadcasts results. Never trust the client.
2. **Never leak hidden information.** A client only ever receives its own cards plus *counts* of opponents' cards. Never send opponents' card identities over the wire.
3. **Money is sacred.** All balances stored as **integer USD cents**. Never use floating point for money. Every balance change is an atomic DB transaction with a row written to a `transactions` ledger. The sum of the ledger must always reconcile with balances.
4. **Provably fair.** Every shuffle is verifiable by players (commit‑reveal seed scheme, below).
5. **Mobile‑first.** The table must look and play great on a phone.

---

## 1. Tech stack (use exactly this)

- **Language:** TypeScript everywhere (server + client share types and the rules engine).
- **Backend:** Node.js 22 + **Fastify** (HTTP/REST) + **Socket.IO** (real‑time).
- **Database:** **PostgreSQL** (users, balances, ledger, matches, seeds) via **Prisma** ORM. **Redis** for live room/game state and pub/sub across server instances.
- **Frontend:** **React + Vite + TypeScript + TailwindCSS**. State via Zustand. Socket.IO client.
- **Auth:** email + password (argon2 hashing) + JWT access/refresh tokens, httpOnly cookies.
- **Payments:** crypto deposits via a hosted provider webhook (e.g. NOWPayments or Coinbase Commerce — pick one, abstract behind a `PaymentProvider` interface); **PayPal** for card payments.
- **Monorepo** layout:

```
/packages
  /engine        -> the provided engine.ts + its tests (the rules core)
  /shared        -> shared TS types (events, DTOs, enums)
  /server        -> Fastify + Socket.IO + Prisma + Redis
  /client        -> React + Vite frontend
```

UI **text shown to players is in Albanian** (lobby, buttons, messages). Code, comments, identifiers, and this spec stay in English.

---

## 2. THE GAME RULES (read carefully — this variant is unusual)

### 2.1 Cards
- A single **54‑card deck**: 52 standard cards (suits ♠ Spades, ♥ Hearts, ♦ Diamonds, ♣ Clubs; ranks 3–10, J, Q, K, A, 2) **plus 2 jokers** (one black, one red).
- Jokers are **never wild** and can **only be played as a single card** (you cannot pair, triple, or sequence jokers).

### 2.2 TWO PARALLEL ORDERINGS (this is the heart of the game)
- **POWER order** — used for singles, pairs, triples, and bombs:
  `3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2 < black joker < red joker`
  (Note: the **2 is very strong**, above the Ace; jokers are the two strongest singles.)
- **SEQUENCE order** — used *inside straights* (kolor / flush) only: natural order where the **Ace is flexible** (low = 1, or high = 14) and the **2 is only ever low** (value 2). This is why `J‑Q‑K‑A‑2` is an **illegal** straight.

### 2.3 Combinations (the only legal plays)
| Combo | Cards | Notes |
|---|---|---|
| **Single** | 1 | any card incl. a joker |
| **Pair** | 2 | two cards of the same rank (no joker pairs) |
| **Triple** | 3 | three of the same rank |
| **Bomb** | 4 | four of the same rank |
| **Kolor** | 5+ | a run of consecutive ranks (SEQUENCE order), **mixed suits** |
| **Flush** | 5+ | a run of consecutive ranks, **all the same suit** |

- Straights (kolor & flush) are **minimum length 5**. The lowest is `A‑2‑3‑4‑5` (Ace low). The highest length‑5 straight is `10‑J‑Q‑K‑A` (Ace high).
- A 4‑card play can ONLY be a bomb (straights need 5+). A same‑suit run of 5+ is always a **flush** (never "just a kolor").

### 2.4 Beating rules (precedence)
A play either **leads** a new trick (any valid combo allowed) or must **beat** the current pile. The comparison precedence:

1. **FLUSH is the ultimate trump.** A flush beats *everything*, including bombs.
   - Flush vs flush: the **longer** flush wins; if equal length, the one with the **higher top card** (SEQUENCE order) wins.
2. **BOMB trumps everything except a flush** (and a stronger bomb).
   - Bomb vs bomb: **higher rank** wins (four 6s beat four 5s).
   - A bomb beats any single (incl. red joker), pair, triple, or kolor.
   - A bomb is beaten **only** by a higher bomb or any flush.
3. **Otherwise**, a play must be the **same category** as the current pile:
   - Single vs single, pair vs pair, triple vs triple → compare by **POWER order**.
   - Kolor vs kolor → the **longer** kolor wins; if equal length, the **higher top card** (SEQUENCE order) wins. (E.g. `3→7` is beaten by `4→8`; a length‑6 kolor beats any length‑5 kolor. `10‑J‑Q‑K‑A` cannot be beaten by any other length‑5 kolor — only by a longer kolor, a bomb, or a flush.)

> Players may **pass even when they could beat** the pile (strategic). Passing only removes you from the *current* trick.

**All of the above is already implemented and unit‑tested in `engine.ts`** (`identifyCombo`, `beats`, `validatePlay`). Use those functions verbatim for every move validation, both on the server (authoritative) and optionally on the client (instant feedback).

### 2.5 Dealing (depends on player count; 54‑card deck)
- **2 players (1v1):** **18 / 18** — the remaining **18 cards stay undealt / dead**.
- **3 players (1v1v1):** **18 / 18 / 18**.
- **4 players (2v2):** **14 / 14 / 13 / 13**.

(Implemented as `engine.dealSizes` / `engine.deal`.)

### 2.6 Who leads
- **First game of a match:** the player holding the **3♠ (three of spades)** leads. (`engine.firstLeaderIndex`, startSuit `'S'`.)
- **Every later game:** the **loser (last place) of the previous game leads**.

### 2.7 Trick flow & game end
- The leader plays any valid combo. Going in turn order, each other player must play a combo that beats the current pile, or pass.
- When all other still‑active players pass in a row, the last player who played **wins the trick** and leads the next one (any valid combo). If that player has no cards left, the lead passes to the next player in order who still has cards.
- A player who empties their hand is **finished**; their finishing position is recorded and they leave the rotation.
- The game ends when only one player still holds cards (that player is **last place**). Finishing order = the order players emptied their hands; the leftover player is last.
  - 1v1 → 1st, 2nd. 1v1v1 → 1st, 2nd, 3rd. 2v2 → 1st, 2nd, 3rd, 4th.

### 2.8 Card switch between games (not on the first game)
Before each game **after the first**, after dealing:
1. The **loser (last place)** of the previous game gives their **single strongest card** (POWER order — could be the red joker) to the **winner (1st place)**.
2. The **winner** then chooses **one card of rank 3–10** from their hand and gives it to the loser.
3. Only the 1st‑place and last‑place players take part. Middle places (2nd / 2nd‑to‑last) do nothing.
4. In 2v2 this is still strictly between the individual 1st‑place and last‑place players, regardless of team.
5. Then the loser leads the new game (per 2.6).

### 2.9 Scoring — points per game
- **1v1:** winner **+1**, loser **0**.
- **1v1v1:** 1st = **2**, 2nd = **1**, 3rd = **0**.
- **2v2:** finishing order 1st/2nd/3rd/4th = **3 / 2 / 1 / 0**. A **team's score for the game = the sum of its two players' points**. The UI must always show **Team 1 total** and **Team 2 total**.

### 2.10 Match target & tie extension
- A match plays multiple games to a **target T**, starting at **T = 21**.
- Track cumulative scores: **per player** (1v1, 1v1v1) or **per team** (2v2).
- After each game:
  - If exactly one side has the **unique maximum** score and that maximum **≥ T** → that side **wins the match**.
  - Else, if the **two leading sides are tied** at the same value **≥ T − 1** (e.g. 20‑20 or 21‑21) → **increase T by 10** (21 → 31 → 41 → …) and keep playing.
- This generalizes the rule "shtyhet vetëm kur janë barazim 20‑20 ose 21‑21, shkon +10".

---

## 3. Rooms, lobby, matchmaking
- Three room types: **1v1**, **1v1v1**, **2v2** (2v2 is always two fixed teams of two).
- A player **creates a room** choosing: type + **stake amount** (USD). Others join open rooms from a **lobby list** (show type, stake, seats filled). For 2v2, support team selection / auto‑assign.
- The match starts when the room is full. Provide a short ready‑check / countdown.

---

## 4. Accounts
- Email + password registration & login. Every player has a unique username, shown at the table.
- JWT auth (access + refresh), argon2 password hashing, sensible rate limits on auth endpoints.
- Each user has a **personal balance** (USD cents).

---

## 5. Wallet, deposits, withdrawals, rake (money flow)

### 5.1 Balance
- **Custodial:** the platform holds balances. Stored as integer **USD cents** on the user (or a `wallets` table). The user always sees **USD ($)** even if they paid with crypto.

### 5.2 Deposits
- **Crypto:** integrate a hosted provider behind a `PaymentProvider` interface. Flow: user requests a deposit → provider gives a payment address/invoice → user pays (BTC, ETH, USDT, USDC, etc.) → provider calls our **webhook** when confirmed → we **verify the webhook signature**, convert to USD at deposit time, **credit the balance automatically**, and write a `transactions` row (idempotent on the provider's payment id — never double‑credit a retried webhook).
- **PayPal:** standard PayPal order/capture flow for card payments; on capture, credit balance + ledger row.

### 5.3 Stakes & rake (the house cut)
- The **stake S** is per player, for the **whole match** (to 21). When a match starts, **debit S** from each player into a **pot** (pot = S × number of players). Rake percentage is **configurable, default 10%**.
- On match end, the house keeps **rake% of the pot**; the winner takes the rest:
  - **1v1:** winner gets pot − rake (e.g. stake $10 → pot $20, winner $18, house $2).
  - **1v1v1:** winner gets pot − rake.
  - **2v2:** the **winning team** gets pot − rake, **split equally** between the two teammates.
- Every debit, payout, and rake amount is a `transactions` ledger row tied to the `match` id.
- Handle **disconnect/abandon** policy explicitly (ask me): e.g. a player who abandons forfeits; define how the pot is settled.

### 5.4 Withdrawals
- User requests a withdrawal to a crypto address (or PayPal). Debit balance, create a pending `withdrawal` transaction, process via provider, mark complete/failed. Add basic limits and an admin approval step.

---

## 6. Admin panel
- Admin auth (separate role). Admins can:
  - **Manually adjust a user's balance** (credit/debit) with a reason — written to the ledger.
  - View users, balances, transactions, active matches.
  - View/triage withdrawals.
- Manual top‑up and the automatic webhook top‑up both go through the **same balance‑credit service** + ledger.

---

## 7. Real‑time protocol (Socket.IO)
Define typed events in `/packages/shared`. At minimum:

**Client → server:** `auth`, `lobby:list`, `room:create`, `room:join`, `room:leave`, `room:ready`, `game:play` (cards), `game:pass`, `game:switchGive` (winner picks the 3–10 card to return).

**Server → client:** `lobby:state`, `room:state`, `match:start`, `game:start` (your hand + opponents' counts + who leads), `game:state` (current pile, whose turn, timers, counts), `game:yourTurn`, `game:trickWon`, `game:playerFinished`, `game:end` (finishing order + points), `card:switch` (what was exchanged, revealed appropriately), `match:scoreboard` (cumulative + team totals + current target T), `match:end` (winner + payout), `error`.

- Each move has a **turn timer**; on timeout, auto‑pass (or auto‑play forced move if leading).
- **Reconnection:** keep live state in Redis keyed by match id. On reconnect, the server pushes a fresh full state to *that socket only* (its own hand + counts). Never broadcast hidden cards.

---

## 8. Provably‑fair shuffle
- Before a game, the server generates a secret **serverSeed** and sends `hash(serverSeed)` (commitment) to all players. Collect a **clientSeed** (per player or room) and a **nonce** (incrementing per game).
- Build a deterministic PRNG from `HMAC_SHA256(serverSeed, clientSeed:nonce)` and feed it into `engine.shuffle(deck, rng)` (Fisher–Yates). **Do not use `Math.random` for the real deal.**
- After the match, **reveal serverSeed** so any player can recompute the exact shuffle and verify it wasn't manipulated. Store seeds + nonce per game for auditing.

---

## 9. Anti‑cheat & integrity
- All move legality decided server‑side via `engine.validatePlay`. Reject and log impossible/illegal plays.
- Never expose other hands; the client renders opponents as face‑down counts.
- Rate‑limit socket events; validate it's actually that player's turn; idempotent webhooks; CSRF protection on REST.

---

## 10. Frontend / UX requirements
- **Login / register**, then a **lobby** (list + create room with type & stake), a **wallet** page (balance, deposit via crypto/PayPal, withdraw, transaction history), and the **game table**.
- **Table = horizontal rectangle**, fully **responsive and great on phones**. Seat layout:
  - 1v1: you bottom, opponent top.
  - 1v1v1: you bottom, opponents top‑left & top‑right.
  - 2v2: you bottom, partner top, opponents left & right (teammates opposite each other); clearly color‑code the two teams.
- Show: your fanned hand (tap to select cards → **Play** / **Pass**), the current pile in the center, each opponent's **card count**, **whose turn** with a visible **timer**, the **scoreboard** (cumulative points, **Team 1 / Team 2 totals** for 2v2, current target T), and a small log of recent plays.
- **Shuffle animation** (a clear randomized shuffle visual) at the start of each game, plus deal animation.
- Clear UI for the **card switch** step: loser auto‑sends strongest card; winner is prompted to pick a 3–10 card to return.
- Polished, fast, smooth; Albanian UI text throughout.

---

## 11. Data model (Postgres / Prisma — minimum)
- `users` (id, username, email, passwordHash, role, balanceCents, createdAt).
- `transactions` (id, userId, type [deposit|withdrawal|bet|payout|rake|admin_adjust], amountCents [signed], currency, status, providerRef [unique, nullable], matchId [nullable], reason, createdAt). The immutable money ledger.
- `matches` (id, type, stakeCents, rakeBps, potCents, status, targetT, winnerSide, createdAt, endedAt).
- `match_players` (matchId, userId, seat, team [nullable], finalScore).
- `games` (id, matchId, index, finishingOrder, serverSeed, serverSeedHash, clientSeed, nonce, revealed).
- `withdrawals` (id, userId, amountCents, address/destination, status).

---

## 12. Build order (phases — implement & test in order)
1. **Engine integration** — wire in the provided `engine.ts` + tests; confirm 47 tests pass in CI.
2. **Single‑game state machine** (`/server`): one game from deal → tricks/passes → finishing order, using the engine. Pure, unit‑tested (no network).
3. **Match layer**: scoring per room type, target‑T + tie extension, the loser↔winner card switch, leader selection. Unit‑tested.
4. **Server + Socket.IO + Redis**: rooms, lobby, auth, authoritative live play, reconnection. Integration‑tested with simulated clients.
5. **Frontend**: lobby, table (all 3 layouts, mobile), animations, scoreboard.
6. **Money**: wallet, balance service + ledger, crypto webhook (idempotent + signature‑verified), PayPal, stake/pot/rake settlement, admin manual top‑up.
7. **Provably‑fair shuffle**, withdrawals, anti‑cheat hardening, deployment.

**Acceptance for each phase:** automated tests pass, and the feature works end‑to‑end in a local dev run before proceeding.

**Start with Phase 1.** Confirm the engine and tests are in place, show me the green test run, then proceed to Phase 2 (the single‑game state machine). Ask me whenever a money or rules detail is ambiguous rather than guessing.
