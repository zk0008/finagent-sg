# FinAgent-SG — Phase V4: Production Scaling

**Goal**: Scale FinAgent-SG from internship demo into a sellable 
autonomous SaaS product for Singapore SMEs.

---

## Status Legend
- ✅ Complete
- 🔄 In Progress
- ⏳ Queued
- 🚫 Deferred (production branch)

---

## TIER 1 — Foundation

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | UI audit and redesign | ✅ | Design system (MASTER.md), warm beige palette, Inter/JetBrains Mono, sidebar layout |
| 2 | Self-serve onboarding | ✅ | Two-step registration, user-scoped schema access, add_client agent tool updated |
| 3 | Scheduled agent runs | 🚫 | Requires production branch — Vercel Cron + database-driven scheduler |
| 4 | Stripe integration | 🚫 | Requires production branch |
| 5 | Email/notification system | 🚫 | Depends on scheduled agent runs — deferred to production branch |
| 6 | Auth hardening | ✅ | Email verification (Resend), password reset, rate limiting (4 routes), 7-day session expiry |
| 7 | Error handling and retry logic | ✅ | Payroll atomicity + dedup, LLM retry (3 attempts), user-friendly error UX with retry button |

## TIER 2 — Growth

| # | Item | Status | Notes |
|---|------|--------|-------|
| 8 | Client dashboard | ⏳ | Overview screen — deadlines, recent runs, financial snapshot |
| 9 | Document management | ⏳ | Persistent store for receipts, invoices, bank statements |
| 10 | IRAS integration prep | ⏳ | Align data formats for Form C-S, CPF submission |
| 11 | Audit trail | ⏳ | Surface agent actions in client-friendly view |
| 12 | Multi-user per company | ⏳ | Owner + accountant roles with different permissions |
| 13 | White-label potential | ⏳ | Accounting firms resell to their clients |

## TIER 3 — Autonomy

| # | Item | Status | Notes |
|---|------|--------|-------|
| 14 | Owner monitoring dashboard | ⏳ | Revenue, system health, failed runs, churn signals |
| 15 | Self-healing agent | ⏳ | Auto-retry with adjusted parameters, escalation chain |
| 16 | Usage metering | ⏳ | Track API costs per client for pricing |
| 17 | Compounding knowledge base | ⏳ | Productionised vault — cross-client anonymised patterns |

---

## Locked Decisions
- PHASES.md and PHASES_V2.md must never be modified
- PHASES_V3.md must never be modified
- All implementation delegated to Claude Code sessions
- Design system: design-system/finagent-sg/MASTER.md
- UI UX Pro Max skill installed at .claude/skills/ui-ux-pro-max/
