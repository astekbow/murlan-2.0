# Privacy Policy — Crypto-Murlan

> ⚠️ **TEMPLATE — NOT LEGAL ADVICE.** This is a working draft that reflects what the
> application actually does with data (verified against the code). It **must be
> reviewed and finalized by a qualified lawyer** for your operating jurisdiction(s)
> before you publish it or scale real-money play. Replace every `[BRACKETED]`
> placeholder. Gambling + crypto + EU/UK personal data each carry specific legal
> obligations this template cannot fully cover.

**Last updated:** [DATE]
**Operator:** [LEGAL ENTITY NAME], [ADDRESS], [COUNTRY]
**Contact / Data Protection:** [privacy@yourdomain]

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
- **Financial & AML records:** retained for **[5 years / your jurisdiction's required
  period]** after the relevant transaction, even after account deletion — this is a
  legal obligation and overrides a deletion request for those specific records (GDPR
  Art.17(3)(b)).
- **Move-logs / match history:** retained for dispute resolution for **[PERIOD]**.
- **IP / technical logs:** retained for **[PERIOD]**. [SET a concrete retention period
  and implement automated purging — currently logs have no automated retention cutoff.]

## 5. Who we share it with
- **Payment / crypto infrastructure** to process deposits and withdrawals
  (e.g. the TRON network, [Binance / your payout provider]).
- **[KYC/AML provider — e.g. Sumsub/Onfido]** for identity verification, once enabled.
- **Regulators, auditors, and law enforcement** where legally required.
- We do **not** sell your personal data.

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

To exercise rights we can't yet self-serve, contact **[privacy@yourdomain]**. We respond
within **[30 days / statutory period]**.

## 7. Security
Passwords are hashed; money operations are transactional and reconciled; admin actions
are audit-logged; sessions can be invalidated. No system is perfectly secure — use a
strong, unique password.

## 8. Responsible gaming
You can set daily deposit/loss limits and self-exclude at any time (Wallet →
responsible-gaming controls). If gambling stops being fun, please use them or contact
[support / a problem-gambling helpline for your region].

## 9. Children
The service is strictly for adults ([18+ / legal age in your jurisdiction]). We do not
knowingly collect data from minors.

## 10. Changes
We may update this policy; we'll post the new version with a revised "Last updated"
date and, for material changes, notify you in-app.

---

### Operator implementation checklist (remove before publishing)
- [ ] Lawyer review for each target jurisdiction + your gambling licence terms.
- [ ] Fill every `[BRACKETED]` value (entity, contact, retention periods, providers).
- [ ] Set + enforce concrete IP/log retention with automated purging (not yet automated).
- [ ] Wire a KYC/AML provider before scaling real money (currently a manual admin enum).
- [ ] Publish this at a stable URL and link it from sign-up + the footer.
- [ ] Decide the financial-record retention period (used by §4 and the deletion flow).
