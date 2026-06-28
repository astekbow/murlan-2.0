# Audit & security archive — index

This folder holds the **historical** audit, security red-team, and UI snapshots. They are kept for the
record (each was a point-in-time assessment); most of their findings have since been fixed. Nothing here
is deleted — `git mv` preserved full history (`git log --follow <file>`).

## 👉 Current state (start here — these live at the repo ROOT, not in this folder)

| Topic | Doc | What it is |
|---|---|---|
| **Engineering / general** | [`AUDIT_REPORT_2026-06-26.md`](../../AUDIT_REPORT_2026-06-26.md) | Latest full forensic audit (72/100) **with a §8 resolution log** — the current baseline. |
| **Security** | [`SECURITY_REDTEAM.md`](../../SECURITY_REDTEAM.md) | 519-agent red-team **with a live FIXED / REMAINING / DEFERRED tracker** — the canonical security status. |
| **Compliance gate** | [`LAUNCH_READINESS.md`](../../LAUNCH_READINESS.md) | Worldwide launch NO-GO — gated by licensing + KYC/AML + GDPR, **not code**. Every later audit defers to this. |
| **Ops / observability** | [`deploy/OBSERVABILITY.md`](../../deploy/OBSERVABILITY.md) | Live runbook for the metrics → Prometheus → Alertmanager → Telegram pipeline (stays in `deploy/`). |

For day-to-day operations see [`RUNBOOK.md`](../../RUNBOOK.md) and [`DEPLOYMENT.md`](../../DEPLOYMENT.md).

## Archive (historical — SUPERSEDED, do not action findings without checking they're still open)

### General / engineering audits (each re-verified the prior; only 06-26 above reflects current state)

| Date | File | Method | Headline verdict |
|---|---|---|---|
| 2026-06-01 | [2026-06-01_audit_production-readiness.md](2026-06-01_audit_production-readiness.md) | 51-agent, 14-area | NOT production-ready; 100 findings, 9 launch blockers (token-refresh, crash-recovery, escrow atomicity, no real payments) |
| 2026-06-08 | [2026-06-08_audit_tournaments-shop-deploy.md](2026-06-08_audit_tournaments-shop-deploy.md) | 6-dimension | 5 criticals (licensing, live-env verify, restart policies, tournament escrow) |
| 2026-06-14 | [2026-06-14_audit_forensic.md](2026-06-14_audit_forensic.md) | 136-agent, 16-dim | 72/100; 0 critical code bugs; High hardening gaps (stub-providers, stack-trace leak, login rate-limit, CORS) |
| 2026-06-24 | [2026-06-24_audit_ultra-forensic.md](2026-06-24_audit_ultra-forensic.md) | Ultra forensic | 80/100; 4 High (Redis crash-safety, swallowed security writes, offsite backups, migrate-on-boot). **Was the undated `AUDIT_REPORT.md` that overwrote an older 2026-06-05 audit — that original is in history (`git log --follow`).** |

### Security red-teams (overlap heavily; the root `SECURITY_REDTEAM.md` supersedes these for status)

| Date | File | Method | Headline |
|---|---|---|---|
| 2026-06-23 | [security/2026-06-23_redteam_55-agent.md](security/2026-06-23_redteam_55-agent.md) | 55-agent | 28 findings (banned-user REST withdraw window, RBAC escalation, claim-jackable deposit address, proxy IP collapse) |
| 2026-06-23 | [security/2026-06-23_redteam_218-agent.md](security/2026-06-23_redteam_218-agent.md) | 218-agent, 109 probes | 106 findings; CRITICAL withdrawal double-pay on operator Approve, socket tokenVersion regression, admin owner-protection |

### UI / product

| Date | File | What |
|---|---|---|
| 2026-06-11 | [ui/2026-06-11_improvement-plan.md](ui/2026-06-11_improvement-plan.md) | Forward-looking product/UX plan (URL routing, admin coverage, confirmations) |
| 2026-06-23 | [ui/2026-06-23_design-audit_table.md](ui/2026-06-23_design-audit_table.md) | Landscape game-table design audit |
| 2026-06-27 | [ui/2026-06-27_ui-audit_rotation.md](ui/2026-06-27_ui-audit_rotation.md) | Full-screen rotation/a11y audit — **premise partly obsolete**: the owner dropped CSS auto-rotate for a "rotate your phone" overlay |

(The mobile responsive harness + report stays self-contained in [`mobile-audit/`](../../mobile-audit/).)

## Recurring threads (same root, tracked across multiple docs → where finally resolved)

- **`__house__` rake FK rollback** — raised in 06-24 (M8 "verify") + 218-agent (money-23); **fixed** as C1 in `AUDIT_REPORT_2026-06-26.md`.
- **Access-token revocation window** (banned/logged-out user keeps REST/socket access for the token TTL) — 55-agent + 218-agent; tracked FIXED in `SECURITY_REDTEAM.md`.
- **P2P transfer AML rail** — 218-agent; `DAILY_TRANSFER_CAP_CENTS` now defaults to $1000 (see `SECURITY_REDTEAM.md`).

> Why these were archived: 13 audit/security/UI `.md` files sat at the repo root next to README/RUNBOOK,
> making it impossible to tell the live tracker from a closed 06-01 snapshot. They're now grouped by
> category with dated names; the 3 live status docs stay at root.
