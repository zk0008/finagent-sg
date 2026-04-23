# FinAgent-SG — PHASES_V2.md
# Post-Submission Improvements

This file is completely separate from PHASES.md.
Do not modify PHASES.md when working on any improvement listed here.
All improvements below are additive — no core workflow logic from Phases 0–7 is changed unless explicitly stated in a specific improvement section.

---

## Improvement Tracking Overview

| ID | Improvement | Status | Claude Code Prompt |
|----|-------------|--------|-------------------|
| A1 | CSV upload support | [DONE] Complete | Prompt A1 |
| A3 | Concurrent component generation | [DONE] Complete | Prompt A3 |
| D  | Mobile-responsive UI | [DONE] Complete | Prompt D |
| C  | Scheduled document ingestion | [DONE] Complete | Prompt C |
| B  | Receipt segregation | [ ] Not started | Prompts B1–B3 |
| E  | Multi-currency support | [ ] Not started | Prompt E |

Status values: [ ] Not started → [WIP] In progress → [DONE] Complete → [BLOCKED] Blocked (reason noted)

---

## Improvement A1 — CSV Upload Support

### What this does
Adds CSV as an accepted file format for trial balance uploads alongside the existing Excel (.xlsx) support. When a CSV is uploaded, it is parsed directly and mapped to the existing TrialBalanceLine Zod schema. Excel parsing via exceljs remains unchanged.

### Decisions locked
- Accept both `.csv` and `.xlsx` in the upload input
- Use papaparse for CSV parsing
- Map CSV columns to the existing TrialBalanceLine Zod schema — no schema changes
- No API route changes
- One new parser branch in the file parser handler

### Files expected to change
- Upload input component (accept attribute)
- File parser handler (new CSV branch alongside existing Excel branch)
- Package: add `papaparse` and `@types/papaparse`

### What must not change
- TrialBalanceLine Zod schema
- API routes
- Excel parsing logic
- Any Phase 0–7 files not listed above

### Completion checklist
- [x] `.csv` and `.xlsx` both accepted in upload input
- [x] CSV parsed correctly and mapped to TrialBalanceLine schema
- [x] Excel upload still works unchanged
- [x] TypeScript compiles clean
- [ ] Tested with a sample CSV trial balance
- [x] PHASES_V2.md status updated to [DONE]

---

## Improvement A3 — Concurrent Component Generation

### What this does
The five FS components (income statement, balance sheet, cash flow statement, notes, XBRL tags) currently generate sequentially. Since all five read from the same classified trial balance input and have no dependency on each other, they are replaced with `Promise.all()` to run concurrently.

### Decisions locked
- Use `Promise.all()` wrapping all five generation calls
- No changes to the generation logic or prompts for any individual component
- No changes to the output schema
- A failure in one component must not silently suppress errors — all rejections must surface

### Files expected to change
- FS generation orchestrator (the file that calls each component generator in sequence)

### What must not change
- Individual component generator functions
- FSOutputSchema
- API routes
- SSE progress streaming logic

### Completion checklist
- [x] All five components fire concurrently via `Promise.all()`
- [x] Individual component logic unchanged
- [x] Errors from any single component surface correctly
- [x] TypeScript compiles clean
- [ ] Tested end-to-end with sample trial balance
- [x] PHASES_V2.md status updated to [DONE]

---

## Improvement D — Mobile-Responsive UI

### What this does
Makes all existing pages usable on mobile without breaking the desktop layout. Applies responsive Tailwind classes to the five main views: dashboard, FS generation, financial model, payroll, and corporate tax. The chatbot panel and history tabs are included.

### Decisions locked
- Tailwind responsive utilities only (`sm:`, `md:` breakpoint prefixes)
- No new components
- No logic changes — UI only
- Touch targets minimum 44px tall for file upload inputs and form elements
- Langfuse observability dashboard is external and out of scope

### Files expected to change
- Page components and layout files for the five main views
- Chatbot panel component
- History tab component

### What must not change
- Any TypeScript logic, API routes, or data processing
- Desktop layout and appearance

### Completion checklist
- [x] Dashboard usable on mobile viewport
- [x] FS generation page usable on mobile viewport
- [x] Financial model page usable on mobile viewport
- [x] Payroll page usable on mobile viewport
- [x] Corporate tax page usable on mobile viewport
- [x] Chatbot panel usable on mobile viewport
- [x] History tabs usable on mobile viewport
- [x] Touch targets at least 44px on all interactive elements
- [x] Desktop layout unchanged
- [x] TypeScript compiles clean
- [x] PHASES_V2.md status updated to [DONE]

---

## Improvement C — Startup-Triggered Document Ingestion

### What this does
Automatically checks monitored government document URLs when the app starts and re-checks after every 24 hours of continuous uptime. When a document has changed, it re-ingests it into ChromaDB and extracts any new values for hardcoded constants, presenting them as a terminal diff for manual confirmation before writing.

### Decisions locked
- Trigger: on `npm run dev` startup + every 24 hours of uptime
- Vector store target: ChromaDB (local) — pgvector/production connection deferred
- No blocking of app startup — fetch runs in background, app starts normally
- Document change detection: SHA-256 hash comparison against stored hash in `scripts/ingest-sources.json`
- Constant extraction: extract new values from changed documents and write to a pending updates file
- Diff display: terminal output on startup showing current vs extracted values
- Confirmation: `npx tsx scripts/applyUpdates.ts` — interactive, one change at a time, final confirmation before any write
- On confirmation: update TypeScript source file constant + update stored hash + re-ingest into ChromaDB
- App hot-reloads automatically on TypeScript file change (Next.js dev mode)
- If extraction is not confident: flag for manual review, do not guess

### Documents to monitor
- CPF Board — contribution rate tables (employee/employer rates, ordinary wage ceiling, additional wage ceiling, SPR graduated rates)
- IRAS — corporate tax documentation (tax rate, YA rebate, partial/full exemption thresholds, Form C-S Lite/C-S/C requirements)
- ACRA/ASC — SFRS updates relevant to Singapore private limited companies

### Hardcoded constants in scope for diff-and-confirm
**CPF engine:**
- Employee and employer contribution rates by age tier
- Ordinary wage ceiling
- Additional wage ceiling
- SPR first and second year graduated rates

**Corporate tax engine:**
- Corporate income tax rate
- YA CIT rebate percentage and cap
- Partial tax exemption thresholds and percentages
- Full tax exemption thresholds for qualifying new companies

**Payroll:**
- SDL rate and cap

**Note:** Claude Code must audit the codebase for any additional hardcoded constants not listed above and include them in scope. Report findings before implementing.

### New files to create
- `scripts/checkGovDocs.ts` — download, hash, compare, extract, write pending updates
- `scripts/applyUpdates.ts` — interactive diff-and-confirm CLI
- `scripts/ingest-sources.json` — config file listing monitored URLs and stored hashes

### Files expected to change
- App startup entry point — wire the background check on dev server start

### What must not change
- ChromaDB client and existing ingest logic (reuse, do not rewrite)
- Any Phase 0–7 application files beyond the startup wiring

### Completion checklist
- [x] `ingest-sources.json` created with all monitored URLs and initial hashes
- [x] `checkGovDocs.ts` runs on startup and logs result to terminal
- [x] Changed documents are re-ingested into ChromaDB automatically
- [x] Detected constant changes surface as terminal diff on startup
- [x] `applyUpdates.ts` runs interactively, one change at a time
- [x] Confirmed changes update the TypeScript source file correctly
- [x] Unconfident extractions flagged for manual review, not guessed
- [x] 24-hour re-check timer resets after each check
- [x] App starts normally regardless of fetch result
- [x] TypeScript compiles clean
- [x] PHASES_V2.md status updated to [DONE]

---

## Improvement B — Receipt Segregation

### What this does
Users upload receipts or bank statement exports for automatic extraction and categorisation into income and expense line items. Extracted data is displayed in an editable table for user review and correction. Confirmed data generates a trial balance, which feeds into the existing FS generation pipeline.

### Decisions locked
- Two separate upload fields: one for income (credit), one for expense (debit)
- Accepted formats: PDF, images (JPG/PNG), CSV
- Extraction method: GPT-4.1 Vision for PDFs and images; papaparse CSV parsing for CSV files
- After extraction: display line items in an editable table (name, amount, date, category) — user can correct any field before proceeding
- Output: generate trial balance from confirmed line items, show preview, export as Excel
- Storage: save extracted transactions to a new `receipts` table within the client's Supabase schema
- Transaction period: client specifies the period when uploading (e.g. March 2026)
- If extraction is not confident for a line item: surface it in the editable table flagged for review, do not drop it silently
- bignumber.js for all amount arithmetic — no native JS math

### New Supabase table (per client schema)
Table name: `receipts`
Columns: id, period, type (income/expense), merchant/description, amount, currency (default SGD), extraction_confidence, created_at, updated_at

### New files to create
- Receipt upload component (two upload fields, editable extraction results table, preview, save/export controls)
- Receipt extraction handler (`app/api/receipts/extract/route.ts`)
- Receipt save handler (`app/api/receipts/save/route.ts`)
- Trial balance generator from receipts (`lib/receiptToTrialBalance.ts`)

### Files expected to change
- Client schema migration — add `receipts` table
- Navigation — add receipt segregation as an entry point

### What must not change
- Existing trial balance upload and FS generation pipeline
- Any Phase 0–7 files not listed above

### Implementation — split into three Claude Code prompts
- **Prompt B1:** Supabase receipts table migration + receipt extraction API route (GPT-4.1 Vision + CSV parsing)
- **Prompt B2:** Receipt upload UI component + editable extraction results table
- **Prompt B3:** Trial balance generation from confirmed receipts + Excel export + navigation wiring

### Completion checklist
- [ ] Two upload fields accept PDF, image, CSV
- [ ] GPT-4.1 Vision extracts line items from PDF and image uploads
- [ ] CSV parsing extracts line items from CSV uploads
- [ ] Extracted line items displayed in editable table
- [ ] Low-confidence extractions flagged visibly in the table
- [ ] User can edit any field before confirming
- [ ] Confirmed data generates a valid trial balance
- [ ] Trial balance preview displayed before saving
- [ ] Trial balance exportable as Excel
- [ ] Transactions saved to receipts table in client Supabase schema
- [ ] Transaction period stored per upload
- [ ] bignumber.js used for all amount arithmetic
- [ ] TypeScript compiles clean
- [ ] PHASES_V2.md status updated to [DONE]

---

## Improvement E — Multi-Currency Support

### What this does
Adds support for foreign currency line items in the trial balance. At generation time, non-SGD amounts are converted to SGD using a live FX rate. Both the original currency amount and SGD equivalent are shown in the financial statements. A foreign currency translation note is added automatically when non-SGD currencies are detected.

### Decisions locked
- Trial balance upload: optional `currency` column — if absent, default to SGD
- FX rate source: free FX API (exchangerate.host or Open Exchange Rates free tier)
- Conversion: fetch rate at generation time, convert to SGD for all calculations
- Display: show original currency amount and SGD equivalent in financial statements
- Auto-disclosure: add foreign currency translation note to the notes section when non-SGD currencies detected
- FX API failure fallback: surface error to user and allow manual rate input — do not block generation
- bignumber.js for all currency conversion arithmetic — no native JS math
- Functional currency remains SGD — no functional currency switching in this phase
- Multi-currency payroll out of scope for this phase

### Files expected to change
- TrialBalanceLine Zod schema — add optional `currency` field (default `'SGD'`)
- FX rate utility (`lib/fxRate.ts` — new file)
- FS generation pipeline — apply conversion before component generation
- Notes generator — detect non-SGD currencies and add disclosure note
- Financial statement display — show dual amounts where applicable

### What must not change
- Core calculation logic in individual component generators
- CPF and payroll computation engine
- Any Phase 0–7 files not listed above

### Completion checklist
- [ ] `currency` column accepted in CSV and Excel trial balance uploads
- [ ] Missing currency column defaults to SGD
- [ ] FX rate fetched at generation time for each non-SGD currency
- [ ] Conversion to SGD applied correctly using bignumber.js
- [ ] Original and SGD amounts shown in financial statements
- [ ] Foreign currency translation note auto-added to notes section
- [ ] FX API failure surfaces error and prompts manual rate input
- [ ] Manual rate input unblocks generation
- [ ] TypeScript compiles clean
- [ ] Tested with a mixed-currency trial balance sample
- [ ] PHASES_V2.md status updated to [DONE]

---

## Continuity Rules for Claude Code Sessions

These rules apply to every Claude Code session working on any improvement in this file.

1. Always read both CLAUDE.md and PHASES_V2.md at the start of every session before doing anything
2. Never modify PHASES.md — it is the original build record and must remain untouched
3. Never modify any Phase 0–7 file unless the specific improvement section above explicitly lists it as a file expected to change
4. Never add features beyond what is listed in the locked decisions for the active improvement
5. Confirm with the user before deviating from any locked decision
6. Update PHASES_V2.md status column after each improvement is confirmed working
7. Report TypeScript compile result after every implementation — never leave compile errors unresolved
