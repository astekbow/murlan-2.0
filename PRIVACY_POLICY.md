# Privacy Policy — Crypto-Murlan

> ⚠️ **TEMPLATE — NOT LEGAL ADVICE.** This is a working draft that reflects what the
> application actually does with data (verified against the code). It **must be
> reviewed and finalized by a qualified lawyer** for your operating jurisdiction(s)
> before you publish it or scale real-money play. Replace every `[BRACKETED]`
> placeholder. Gambling + crypto + EU/UK personal data each carry specific legal
> obligations this template cannot fully cover.

**Last updated:** 2026-06-22
**Operator:** [LEGAL ENTITY NAME], [ADDRESS], [COUNTRY] — ⚠️ STILL TO FILL (your registered
gambling operator entity; required before publishing)
**Contact / Data Protection:** astekbow@gmail.com — ⚠️ replace with a role alias on your
domain (e.g. privacy@yourdomain) before publishing

---

## 1. Who we are
Crypto-Murlan ("we", "us") operates an online real-money multiplayer card game.
This policy explains what personal data we collect, why, how long we keep it, and the
rights you have over it.

## 2. What data we collect
- **Account:** username, email address, password (stored only as a salted hash —
  never in plaintext), account creation date, email-verification status.
- **Responsible-gaming / compliance:** date of birth and country (for age/geo
  eligibility), self-exclusion status, daily deposit/loss limits, KYC status.
- **Financial:** wallet balance, the full transaction ledger (deposits, stakes,
  payouts, rake), withdrawal requests and their on-chain/payment references, and your
  assigned crypto (USDT-TRC20) deposit address.
- **Gameplay:** match history, move-logs (for replay + dispute resolution), ranked
  rating, XP, cosmetics.
- **Technical:** IP address (for security, fraud/AML, and geo checks) and basic
  device/connection data. Optional Web-Push subscription if you enable notifications.

## 3. Why we use it (legal bases)
- **Contract** — to run your account, the games, and the wallet you signed up for.
- **Legal obligation** — anti-money-laundering (AML), age verification, tax, and
  gambling-licence record-keeping. [CONFIRM the specific obligations for your licence.]
- **Legitimate interests** — fraud/collusion prevention, security, and service
  improvement, balanced against your rights.
- **Consent** — optional push notifications (withdraw any time).

## 4. How long we keep it (retention)
- **Personal profile:** retained while your account is open. On deletion (see §6) it is
  **anonymized**.
- **Financial & AML records:** retained for **5 years** after the relevant transaction
  (a common AML default — ⚠️ confirm YOUR jurisdiction's required period with your
  lawyer), even after account deletion — this is a legal obligation and overrides a
  deletion request for those specific records (GDPR Art.17(3)(b)).
- **Move-logs / match history:** retained for dispute resolution; pruned by the server's
  data-retention sweep per the `MOVELOG_RETENTION_DAYS` setting (default: kept while an
  account is active, as replays/disputes may reference them).
- **IP / technical logs:** IP addresses appear only in the server's **ephemeral container
  logs (stdout)** — they are **never written to the database**, so there is nothing to
  purge in storage. Retention is bounded by Docker's log rotation (configure
  `json-file` `max-size`/`max-file`, e.g. 20 MB × 5). If you ship logs to an external
  aggregator (Loki/ELK), set its retention there too.

## 5. Who we share it with
- **Payment / crypto infrastructure** to process deposits and withdrawals: the **TRON
  network** + **TronGrid** (verifying your USDT-TRC20 deposit on-chain) and **Binance**
  (sending withdrawal payouts).
- **Email delivery** — **Resend** (account verification + password-reset emails).
- **Operator alerting** — **Telegram** (the operator receives withdrawal/ops alerts; this
  carries username + amount, not your wider personal data).
- **KYC/AML provider** (e.g. Sumsub/Onfido) for identity verification — **not yet
  integrated; to be added before scaling real money.**
- **Regulators, auditors, and law enforcement** where legally required.
- ⚠️ A signed **Data Processing Agreement (GDPR Art.28)** is required with each of the
  above before processing EU users' data — see the checklist.
- We do **not** sell your personal data, and we use **no advertising or tracking
  cookies** — only essential cookies for login/session.

## 6. Your rights
Depending on where you live (e.g. GDPR/UK-GDPR/CCPA) you may have the right to:
- **Access / portability** — download all data we hold about you. This is built in:
  Wallet → *Download my data* (`GET /api/account/export`).
- **Deletion ("right to be forgotten")** — delete your account. This is built in:
  Wallet → *Delete my account* (`POST /api/account/delete`). It **anonymizes** your
  personal data and closes the account; **financial/AML records are retained** for the
  legal period (§4) with the now-anonymized identifier.
- **Rectification** — correct your data (date of birth / country are locked after KYC
  verification).
- **Object / restrict / withdraw consent** — e.g. turn off push notifications.

To exercise rights we can't yet self-serve, contact us (see the **Contact** address at the
top). We respond within **30 days** (or your jurisdiction's statutory period if shorter).

## 7. Security
Passwords are hashed; money operations are transactional and reconciled; admin actions
are audit-logged; sessions can be invalidated. No system is perfectly secure — use a
strong, unique password.

## 8. Responsible gaming
You can set daily deposit/loss limits and self-exclude at any time (Wallet →
responsible-gaming controls). If gambling stops being fun, please use them or reach out
via our Support page — and contact a problem-gambling helpline for your region
(⚠️ add the specific helpline for your licensed market here before publishing).

## 9. Children
The service is strictly for adults — **18+** (or the higher legal gambling age in your
jurisdiction, if applicable). We do not knowingly collect data from minors.

## 10. Changes
We may update this policy; we'll post the new version with a revised "Last updated"
date and, for material changes, notify you in-app.

---

### Operator implementation checklist (remove before publishing)
Filled in this draft from the code: collected-data inventory (§2), processors (§5),
built-in access/export + delete rights (§6), no-tracking-cookies stance, IP-in-ephemeral-
logs retention model (§4), 18+ (§9), update date. **Still REQUIRED before you publish /
scale real money:**
- [ ] **Lawyer review** for each target jurisdiction + your gambling-licence terms (this is
      still a template — do not publish unreviewed).
- [ ] Fill the **legal-entity name, address, country** (header) and a **privacy@ role
      alias** on your domain (replace the personal email).
- [ ] **Confirm the financial/AML retention period** for your jurisdiction (the draft
      assumes 5 years in §4) and your licence's record-keeping obligations (§3).
- [ ] **Sign a DPA** with each sub-processor (TronGrid/Binance/Resend/Telegram) — GDPR Art.28.
- [ ] **Wire a KYC/AML provider** before scaling real money (currently a manual admin enum).
- [ ] Add your region's **problem-gambling helpline** (§8).
- [ ] Set Docker log rotation (or external-aggregator retention) for IP/technical logs (§4).
- [ ] **Publish** at a stable URL and link it from sign-up + the footer (+ the in-app
      privacy notice already shown on first visit).
