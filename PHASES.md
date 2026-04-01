# FinAgent-SG — Phase Build Log

---

## Phase 0 — Foundation
**Status:** Complete
**Date:** 2026-03-27

### Files Built
| File | Purpose |
|------|---------|
| `app/layout.tsx` | Root layout |
| `app/page.tsx` | Main single-page UI shell |
| `app/globals.css` | Tailwind global styles |
| `components/WorkflowPanel.tsx` | Left panel shell (wired in Phase 2) |
| `components/ChatbotPanel.tsx` | Right panel shell |
| `components/BottomNav.tsx` | Bottom navigation |
| `lib/chromaClient.ts` | ChromaDB client + collection helper |
| `lib/schemaUtils.ts` | `generateSchemaName()` utility |
| `lib/schemas.ts` | Zod schemas: Entity, FiscalYear, TrialBalanceLine, FinancialStatement, Employee, CPFContribution |
| `lib/utils.ts` | Tailwind merge utility |
| `supabase/schema.sql` | Multi-tenant PostgreSQL schema |
| `auth.ts` | NextAuth email/password config |
| `middleware.ts` | NextAuth middleware |

### Decisions
- NextAuth email/password only — no OAuth, no magic link
- Zod as single source of truth for all data shapes
- ChromaDB v2 API via Docker on port 8000

---

## Phase 1 — RAG Pipeline
**Status:** Complete
**Date:** 2026-03-28

### Files Built
| File | Purpose |
|------|---------|
| `lib/ingest.ts` | Core ingestion logic (`ingestFile`) — PDF/TXT chunking + embedding |
| `lib/ragQuery.ts` | `ragQuery(question, nResults?)` → `RagResult[]` |
| `app/api/ingest/route.ts` | POST `/api/ingest` — called by ChatbotPanel |
| `scripts/ingest.ts` | CLI bulk ingestion from `docs/knowledge/` |
| `scripts/testRag.ts` | Dev test: 5 sample accounting queries |

### Decisions
- pdf-parse v2: class-based API — `new PDFParse({ data: Uint8Array }) → getText()`
- ChromaDB npm v3: use `host` + `port` config, not `path` (path is deprecated)
- `ingestFile` lives in `lib/` (not `scripts/`) to prevent Next.js build from executing `main()`
- Embedding model: `text-embedding-3-small` — must stay in sync across ingest and query

### Known Issues
- `middleware.ts` deprecation warning (Next.js 16.2 renamed to `proxy.ts`) — not fixed, flagged to user

---

## Phase 2 — FS Preparation Agent
**Status:** Complete
**Date:** 2026-03-29

### Files Built
| File | Purpose |
|------|---------|
| `lib/excelParser.ts` | Trial balance Excel parser (exceljs) — validates balance, rejects bad rows |
| `lib/accountClassifier.ts` | AI + RAG SFRS account classifier (GPT-4.1-mini) |
| `lib/exemptionChecker.ts` | Singapore small company / EPC audit exemption checker (pure TS) |
| `lib/calculationEngine.ts` | bignumber.js arithmetic: sumAccounts, netProfit, retainedEarnings, BS validation |
| `lib/fsGenerator.ts` | AI FS assembly: Balance Sheet, P&L, Cash Flow, Equity, Notes, XBRL tags (GPT-4.1) |
| `lib/pdfGenerator.ts` | pdfkit PDF generator — all 5 FS components in one A4 PDF |
| `trigger/fsGenerationJob.ts` | Trigger.dev v4 background job — full pipeline with progress events |
| `app/api/generate-fs/route.ts` | POST → SSE stream — runs pipeline inline, streams progress to frontend |
| `app/api/generate-pdf/route.ts` | POST → PDF binary download |
| `components/WorkflowPanel.tsx` | Wired: file upload, config form, SSE progress, download buttons |
| `scripts/createSampleTrialBalance.ts` | Script to generate the sample .xlsx file |
| `docs/samples/sample_trial_balance.xlsx` | 41-account balanced trial balance (SGD 1,207,800) for TechSoft Pte Ltd |
| `skills/sg-accounting-standards/SKILL.md` | Custom Claude Code skill with SG accounting rules |
| `lib/schemas.ts` | Added: ClassifiedAccountSchema, ExemptionInputSchema, ExemptionResultSchema, FSGeneratorInputSchema, FSOutputSchema |

### Packages Installed
| Package | Version | Purpose |
|---------|---------|---------|
| `pdfkit` | latest | PDF generation |
| `@types/pdfkit` | latest | TypeScript types for pdfkit |
| `@trigger.dev/sdk` | 4.4.3 | Background job processing |

### Vercel Skills Installed
All 6 available skills from `vercel-labs/agent-skills` were installed to `.agents/skills/`:
- `vercel-composition-patterns`
- `deploy-to-vercel`
- `vercel-react-best-practices`
- `vercel-react-native-skills`
- `vercel-cli-with-tokens`
- `web-design-guidelines`

Note: The exact skill names in the blueprint (`frontend-design`, `nextjs-performance`, `skill-creator`) are not published by vercel-labs — the above are the closest available equivalents. All were installed.

### Decisions Made
| Decision | Reason |
|----------|--------|
| GPT-4.1-mini for account classification | Cost-efficient for high-volume per-line classification |
| GPT-4.1 (full) for FS generation | Accuracy critical — errors cause ACRA rejection |
| SSE route runs pipeline inline (not via Trigger.dev cloud) | Dev/demo mode works without TRIGGER_SECRET_KEY; Trigger.dev job is the production upgrade path |
| File transmitted as base64 in request body | Avoids multipart form setup; sufficient for trial balance files (<5MB) |
| XBRL output is JSON tag map | Full XBRL XML generation is out of scope for Phase 2 |
| Buffer → `new Uint8Array(buffer)` in Response | Next.js App Router `BodyInit` does not accept Node.js `Buffer` directly |
| `pdfkit` TextOptions: x/y as positional args | pdfkit's TextOptions type does not include `x`/`y` — use the `(text, x, y, options)` overload |
| Sample trial balance: 41 accounts, SGD 1,207,800 | Realistic SG software company; DBS cash balance adjusted to achieve debit = credit |

### Deviations from Blueprint
| Deviation | Reason |
|-----------|--------|
| `frontend-design`, `nextjs-performance`, `skill-creator` skills not installed | Not published by vercel-labs; 6 available equivalents installed instead |
| Trigger.dev job does not save to Supabase on completion | Supabase output table schema not yet designed for Phase 2 outputs; wiring deferred |
| "Preview" button in WorkflowPanel is disabled | In-browser FS preview not specified in Phase 2 scope; left disabled |

### PDF Bug — Resolved
**Root cause:** Next.js/Turbopack was bundling `pdfkit`, rewriting the internal font `.afm` file paths to `/ROOT/...` which do not exist at runtime. `new PDFDocument()` threw `ENOENT: no such file or directory, open '.../Helvetica.afm'`.

**Fix:** Added `serverExternalPackages: ["pdfkit"]` to `next.config.ts` so Next.js requires pdfkit at runtime instead of bundling it, keeping font paths intact.

**Fixes kept from debugging (permanent):**
1. Null guard in `renderLineItems` (`lib/pdfGenerator.ts`) — filters null/undefined entries the AI may inject into line item arrays
2. `FSOutputSchema.parse()` applied to AI output in `lib/fsGenerator.ts` — ensures `z.preprocess()` coercions fire on the raw AI response
3. `z.preprocess()` on `FSOutputSchema.notes` (`lib/schemas.ts`) — coerces plain object → array, null → `[]`
4. `embeddingFunction: null` in both `getOrCreateCollection` calls (`lib/chromaClient.ts`, `lib/ragQuery.ts`) — suppresses ChromaDB DefaultEmbeddingFunction warning
5. Debug console logs added during diagnosis were cleaned up after fix

### Open Items (deferred to future)
- Wire Trigger.dev job's completion output to Supabase `outputs` table
- Full XBRL XML generation for ACRA BizFile+ filing (ask user first)
- `TRIGGER_SECRET_KEY` env var needed for Trigger.dev cloud production mode

---

## Phase 3 — Financial Model Agent
**Status:** Complete
**Date started:** 2026-03-29
**Date completed:** 2026-03-30

### Prompt 1 — Supabase Output Saving
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `lib/supabaseClient.ts` | New — singleton server-side Supabase client (service role key) |
| `lib/outputStorage.ts` | New — `saveGeneratedFS()`, `getLatestFS()` |
| `app/api/generate-fs/route.ts` | Added `save_output` SSE step after `generate_fs` |
| `components/WorkflowPanel.tsx` | Added `save_output` to `INITIAL_STEPS` |
| `supabase/schema.sql` | `outputs` table: removed `file_url NOT NULL`, added `structured_data`, `classified_accounts`, `exemption_result`, `pdf_data` columns |

#### Decisions
| Decision | Reason |
|----------|--------|
| Service role key (`SUPABASE_SERVICE_ROLE_KEY`) | Server-only routes; bypasses RLS for multi-tenant schema writes |
| `NEXT_PUBLIC_SUPABASE_URL` (not `SUPABASE_URL`) | Matches existing env var in `.env.local` |
| `pdf_data: null` on save | PDF is generated on-demand; no need to store it at FS generation time |

---

### Prompt 2 — In-Browser FS Preview Modal
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `components/FSPreview.tsx` | New — shadcn/ui Dialog modal rendering all 5 FS sections + XBRL table |
| `components/WorkflowPanel.tsx` | Preview button wired to `setPreviewOpen(true)`; FSPreview mounted |

#### Decisions
| Decision | Reason |
|----------|--------|
| shadcn/ui Dialog | Already in stack; zero extra dependencies |
| No API calls in FSPreview | Renders from existing `fsOutput` state — no round-trip needed |
| Negative amounts in parentheses | Standard accounting display convention |

---

### Prompt 3 — Database Layer for Phase 3
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `lib/modelStorage.ts` | New — `getLatestFSOutput()`, `saveFinancialModel()`, `getActiveModel()`, `getFinancialModel()`, `listFinancialModels()` |
| `lib/schemas.ts` | Added `ProjectionAssumptionsSchema`, `ProjectedFSSchema`, `FinancialModelSchema` |
| `supabase/schema.sql` | Added `financial_models` table + partial unique index |

#### Decisions
| Decision | Reason |
|----------|--------|
| INSERT-only model saves | Every generation is a new row; history preserved |
| Partial unique index `WHERE is_active = true` | DB-enforced one-active-model constraint; avoids application-layer race conditions |
| Deactivate-then-insert (two steps) | Partial unique index requires the old active row be cleared before inserting the new one |
| `listFinancialModels` returns summary only | Avoids loading large JSONB projection arrays for the history list |

---

### Prompt 4 — Projection Engine
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `lib/projectionEngine.ts` | New — `projectFinancials()`, `validateProjection()` |
| `lib/calculationEngine.ts` | Added `applyGrowthRate()`, `computeDepreciation()` |

#### Decisions
| Decision | Reason |
|----------|--------|
| Cash as BS plug | Simplest approach that guarantees Assets = Liabilities + Equity each year without per-asset tracking |
| COGS detection via name keywords + code prefix "62" | `ClassifiedAccount` has no COGS subcategory; heuristic covers standard SG chart of accounts |
| Straight-line: fixed charge from base-year NBV | No per-asset data; fixed annual charge from aggregate NCA balance ÷ DEFAULT_USEFUL_LIFE (5 yrs) |
| Reducing balance: pass current NBV as "cost", year=1 | `computeDepreciation` supports any starting point; passing year=1 applies rate to current balance |
| `applyGrowthRate` / `computeDepreciation` return strings | Preserves BigNumber precision across call chains; callers convert to BigNumber as needed |
| No AI calls in projection engine | All arithmetic only; AI is used upstream (assumption suggester, Prompt 5) |

---

---

### Prompt 5 — AI Assumption Suggester
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `lib/assumptionSuggester.ts` | New — `suggestAssumptions()` using GPT-4.1-mini + RAG context |
| `app/api/model/suggest-assumptions/route.ts` | New — POST endpoint; returns `{ assumptions, rationales }` |

#### Decisions
| Decision | Reason |
|----------|--------|
| GPT-4.1-mini for suggestions | Cost-efficient; suggestions are advisory, not compliance-critical |
| RAG injected before AI call | Singapore economic/tax context improves relevance of revenue growth and tax rate suggestions |
| Singapore tax hint in system prompt | Audit-exempt companies → ~8.5% effective rate; otherwise → 17% statutory rate |
| `AISuggestionSchema` includes `*_rationale` fields | Single AI call returns both values and reasoning; avoids a second round-trip |
| Returns `{ assumptions, rationales }` separately | Frontend can display rationales as tooltips without coupling them to numeric inputs |

---

### Prompt 6 — Scenario Analysis
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `lib/scenarioAnalysis.ts` | New — `generateScenarios()`, `runAllScenarios()` |

#### Decisions
| Decision | Reason |
|----------|--------|
| Named constants at top of file (`BEST_REVENUE_DELTA=5`, etc.) | Single place to tune scenario deltas without touching logic |
| Deterministic only — no AI | Scenarios are sensitivity analysis, not forecasting; AI adds noise |
| Tax rate / depreciation method / custom overrides carry through unchanged | Only growth rates change between scenarios; structural assumptions stay fixed |
| Worst-case revenue floor at 0% growth | Revenue should not go negative in a scenario model; `WORST_REVENUE_FLOOR_PCT=0` prevents that |

---

### Prompt 7 — Budget-vs-Actual Engine
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `lib/budgetVsActual.ts` | New — `compareBudgetVsActual()`, `summarizeBVA()`, `BudgetVsActualItem`, `BVASummary` |
| `lib/modelStorage.ts` | Added `updateModelActuals()` — the one permitted UPDATE to an existing model row |
| `app/api/model/upload-actuals/route.ts` | New — parse actuals file, run BVA, merge with existing actuals by year |

#### Decisions
| Decision | Reason |
|----------|--------|
| Match by normalised account_name | Projected FS line items have only `label` (account_name), not account_code |
| Unmatched items included with zero on missing side | Shows what's budget-only or actuals-only; never silently drops data |
| Favorable logic: Revenue/Asset/Equity → actual > budget; Expense/Liability → actual < budget | Standard accounting convention |
| BigNumber.js for all arithmetic | Consistent with rest of codebase; no float drift in variance % |
| `updateModelActuals` is the only permitted UPDATE | All other model changes are INSERTs; actuals are additive and belong to an existing model row |
| Merge by year (filter out same year, append new) | Multiple years' actuals can exist; re-uploading a year replaces only that year |
| `net_profit_variance = revenue_variance - expense_variance` | P&L identity: improved revenue and lower expenses both improve net profit |

---

### Prompt 8 — Financial Model Dashboard UI
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `components/ModelWorkflow.tsx` | New — 4-step financial model UI (~850 lines) |
| `components/ProjectionTable.tsx` | New — P&L / Balance Sheet projection table (3 scenarios side-by-side) |
| `components/VarianceTable.tsx` | New — Budget-vs-actual variance table with summary cards |
| `app/api/model/latest-fs/route.ts` | New — GET endpoint; returns FS metadata for a schema |
| `app/api/model/run/route.ts` | New — SSE endpoint; projects base/best/worst scenarios |
| `app/api/model/save/route.ts` | New — POST endpoint; saves full model to DB |
| `components/WorkflowPanel.tsx` | ModelWorkflow mounted; financial_model radio enabled |

#### Decisions
| Decision | Reason |
|----------|--------|
| Tables only, no charts | Phase 3 scope; charts explicitly deferred |
| No history tab | Explicitly deferred; INSERT-only model DB is the history layer |
| 4-step state machine in ModelWorkflow | Clear progression: check FS → set assumptions → run → save → BVA |
| Step 4 (BVA) only renders after savedModelId is set | Cannot upload actuals against an unsaved model |
| base_year extracted from `structured_data.balance_sheet.as_at_date` | Avoids a separate DB column; as_at_date is always stored as ISO string |
| SSE pattern mirrors generate-fs route | Consistent frontend reading logic; reuses the same `data: ${JSON.stringify(event)}\n\n` format |

#### Deviations
| Deviation | Reason |
|-----------|--------|
| Base UI `Select.onValueChange` types value as `string \| null` | Base UI (not Radix UI) has different typing; null guard added: `if (v != null) setBvaYear(parseInt(v, 10))` |
| shadcn/ui table, tabs, select installed at Prompt 8 | Not pre-installed; added via `npx shadcn@latest add table tabs select --yes` |

---

### Prompt 9 — Excel Export
**Status:** Complete

#### Files Built / Modified
| File | Change |
|------|--------|
| `lib/modelExcelExport.ts` | New — `generateModelExcel()` — 8-sheet ExcelJS workbook |
| `app/api/model/export-excel/route.ts` | New — POST endpoint; returns binary .xlsx download |
| `components/ModelWorkflow.tsx` | Download Excel button wired to `handleExcelDownload()` |

#### Decisions
| Decision | Reason |
|----------|--------|
| 8 sheets: Assumptions, Base P&L, Best P&L, Worst P&L, Base BS, Best BS, Worst BS, BVA (optional) | Complete picture in one workbook; BVA sheet only if BVA data is present |
| ExcelJS (not SheetJS) | Already in stack from Phase 2; consistent tooling |
| `wb.xlsx.writeBuffer()` → `Buffer.from(arrayBuffer)` → `new Uint8Array(buffer)` | `writeBuffer()` returns `ArrayBuffer`; App Router Response requires `Uint8Array` |
| No extra DB call in export route | Frontend sends full model state already in memory; avoids unnecessary Supabase round-trip |
| Safe filename: replace `/[^a-z0-9_-]/gi` → `_`, slice 0–40 | Prevents path traversal and overly long filenames |
| Number format `#,##0.00` on all amount cells | Standard financial display with 2 decimal places |
| Color scheme: `FFD6E4F7` headers (light blue), `FFF2F2F2` sections (grey), `FFD1FAE5`/`FFFEE2E2` BVA favorable/unfavorable | Clear visual hierarchy; green/red for variance rows matches UI convention |

---

### Prompt 10 — Final Wiring and Cleanup
**Status:** Complete

#### Files Modified
| File | Change |
|------|--------|
| `components/WorkflowPanel.tsx` | Company name moved outside FS-only conditional — always visible for both tasks |
| `CLAUDE.md` | Phase 3 → Complete; Phase 4 → Next; project structure updated; deferred items updated |
| `PHASES.md` | Full Phase 3 section added (Prompts 5–10) |

#### Bug Fixed
| Bug | Fix |
|-----|-----|
| Company name input hidden when financial_model task selected | Extracted company name into a dedicated always-visible Card above the task-specific conditionals; removed duplicate field from FS Configure card |

#### TypeScript Verification
- `npx tsc --noEmit` passed with zero errors after all Phase 3 files were built

#### Decisions
| Decision | Reason |
|----------|--------|
| Company name card placed between task selector and task-specific blocks | Shared by both FS and Model tasks; both derive `schemaName` via `generateSchemaName(companyName)` |
| No Phase 4 logic added | Strict scope rule; Phase 4 starts when explicitly instructed |

---

## Phase 4 — Payroll & CPF Agent
**Status:** Complete
**Date completed:** 2026-03-31

### Skill Created
| File | Purpose |
|------|---------|
| `skills/sg-payroll-cpf/SKILL.md` | CPF rates (1 Jan 2026), SDL, FWL, payslip requirements, CPF e-Submit format |

### Files Built
| File | Purpose |
|------|---------|
| `lib/cpfEngine.ts` | Pure-arithmetic CPF engine — `getAgeAtDate`, `getCPFRates`, `computeCPF`, `computePayroll` |
| `lib/payslipGenerator.ts` | pdfkit MOM-compliant payslip PDF — `generatePayslip()` |
| `lib/cpfSubmissionExport.ts` | CPF e-Submit CSV — `generateCPFSubmission()` |
| `lib/payrollJournal.ts` | Double-entry journal entries — `generatePayrollJournalEntries()`, `getLastDayOfMonth()` |
| `app/api/payroll/run/route.ts` | POST run payroll + PATCH finalise |
| `app/api/payroll/payslip/route.ts` | POST generate individual payslip PDF |
| `app/api/payroll/export-cpf/route.ts` | POST CPF e-Submit CSV download |
| `app/api/payroll/journal/route.ts` | POST payroll journal entries JSON |
| `app/api/payroll/employees/route.ts` | GET list + POST create employee |
| `app/api/payroll/employees/[id]/route.ts` | PUT update + DELETE employee |
| `components/PayrollWorkflow.tsx` | 3-step payroll UI — employee setup → run → download |

### Files Modified
| File | Change |
|------|--------|
| `supabase/schema.sql` | Replaced Phase 0 employees stub; added `payroll_runs` and `payslips` tables |
| `lib/schemas.ts` | Updated `EmployeeSchema` (citizenship values, nric_fin, created_at); added `PayrollRunSchema`, `PayslipSchema`, `CPFComputationInputSchema`, `CPFComputationResultSchema`, `JournalEntrySchema` |
| `components/WorkflowPanel.tsx` | Enabled payroll radio; imported and mounted `PayrollWorkflow` |
| `CLAUDE.md` | Phase 4 → Complete; Phase 5 → Next; project structure updated; deferred items updated |

### Decisions
| Decision | Reason |
|----------|--------|
| No AI in any Phase 4 module | CPF is deterministic law — AI would introduce rounding errors and compliance risk |
| bignumber.js for all CPF arithmetic | Consistent with rest of codebase; prevents float drift on cent-level rounding |
| CPF phased-in formula generalised to all tables | `factor = employee_rate × 3` is mathematically derived from continuity at $750 boundary; verified for all age bands in Tables 1–3 |
| Run route returns `payslip_ids` map | Allows UI to call payslip PDF endpoint per employee without a second DB lookup |
| PATCH on run route for finalise | Avoids a separate `/finalise` endpoint; status update is a natural PATCH semantics |
| DELETE employee accepts schemaName via query param | DELETE requests may have no body in some browsers; query param is safer |
| CPF preview column shows `—` until Run Payroll clicked | Live preview would require either a preview endpoint (not in scope) or client-side arithmetic (violates bignumber.js rule); results appear immediately after the run |
| Sequential payslip downloads (one per employee) | Browser-native; no zip library needed; small delay prevents browser blocking |
| ytd_ow defaults to "0" | Simplest correct implementation for per-month computation; full YTD tracking deferred |
| Journal entries aggregated (5 combined entries) | Cleaner general ledger posting than one set per employee; descriptions include employee count |
| FWL flagged only — not computed | Rates vary by sector and DRQ; MOM schedules change; manual review required |

### Deviations from Blueprint
| Deviation | Reason |
|-----------|--------|
| CPF e-Submit CSV includes comment header rows | Aids auditing; portal strips non-data rows; noted as a deferred strip-on-upload item |
| Payslip `Finalise` disables payslip PDF download (UX choice) | Finalised runs are locked; payslips should be downloaded before finalising |

### Open Items (deferred)
- FWL computation — UI displays manual-input reminder; rates not computed
- YTD OW tracking per employee for precise AW ceiling (current: ytd_ow=0 default)
- Payslip zip download (download all in one file) — requires a zip library not yet in stack
- CPF e-Submit comment header stripping — portal may need clean CSV without `#` lines

