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

---

## Phase 5 — Continuous Improvement Pipeline
**Status:** Complete
**Date completed:** 2026-04-03

### Files Built
| File | Purpose |
|------|---------|
| `docker-compose.yml` | Langfuse (web + worker) + PostgreSQL + ChromaDB — all local infra in one compose |
| `docker-compose.env.example` | Docker secrets template (copy to docker-compose.env and fill in) |
| `lib/langfuse.ts` | Singleton Langfuse client + `flushLangfuse()` helper |
| `lib/modelRouter.ts` | Centralised model routing — `MODEL_ROUTES` constant for all AI tasks |
| `app/api/chat/route.ts` | POST /api/chat — correction detection + RAG-answered questions |
| `app/api/corrections/route.ts` | GET corrections list + PATCH status to "reviewed" |
| `app/corrections/page.tsx` | Correction review interface — filter by status, mark as reviewed |
| `scripts/exportTrainingData.ts` | Export reviewed corrections as OpenAI fine-tuning JSONL |
| `scripts/runFineTuning.ts` | Upload JSONL + create fine-tuning job (CLI, not triggered automatically) |
| `docs/training/README.txt` | Fine-tuning instructions: when, how, how to activate |

### Files Modified
| File | Change |
|------|--------|
| `lib/accountClassifier.ts` | Langfuse trace + generation per account; MODEL_ROUTES.account_classification |
| `lib/fsGenerator.ts` | Langfuse parent trace + 5 child generations; MODEL_ROUTES.fs_generation |
| `lib/assumptionSuggester.ts` | Langfuse trace + generation; MODEL_ROUTES.assumption_suggestion |
| `lib/ragQuery.ts` | Langfuse span per RAG query; optional parent trace param |
| `lib/ingest.ts` | Added `ingestText()` for direct text ingestion (used by chat corrections) |
| `components/ChatbotPanel.tsx` | Send button wired to POST /api/chat; schemaName prop added |
| `components/BottomNav.tsx` | Added "Corrections" link between History and Settings |
| `supabase/schema.sql` | Updated corrections table: nullable output_id, message field, created_at |
| `app/api/generate-fs/route.ts` | Added `flushLangfuse()` in SSE stream finally block |
| `app/api/model/suggest-assumptions/route.ts` | Added `flushLangfuse()` before response |
| `.env.example` | Added LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST |
| `.gitignore` | Added docker-compose.env, docs/training/training_data.jsonl |
| `CLAUDE.md` | Phase 5 → Complete; Phase 6 → Next; project structure updated |

### Packages Installed
| Package | Purpose |
|---------|---------|
| `langfuse` | Langfuse TypeScript SDK for observability |
| `openai` | OpenAI SDK for fine-tuning script (Files API + Jobs API) |

### Decisions
| Decision | Reason |
|----------|--------|
| Vercel AI SDK v6 uses `inputTokens`/`outputTokens` (not `promptTokens`/`completionTokens`) | AI SDK 6.x renamed these fields — discovered via TypeScript check |
| Langfuse `flushAt: 1` in singleton | Server-side Next.js process may not survive long enough for background flush; flush immediately |
| `flushLangfuse()` in API route, not lib files | Lib files don't know when the HTTP response is closing; route is the correct place to flush |
| ragQuery accepts optional parent trace | Allows RAG spans to appear under the calling trace (fs_generation, account_classification) without requiring function signature changes that would break callers |
| ChatbotPanel sends schemaName with every message | API route needs to know which client schema to write corrections to |
| Corrections table: nullable output_id, message field | Chatbot sends raw message strings — not structured field/original/corrected; output_id optional for standalone corrections |
| Fine-tuning scripts are CLI-only, not triggered automatically | Phase 5 requirement: build infrastructure, do not trigger; triggering is a Phase 6 decision |
| exportTrainingData reads information_schema to discover schemas | Avoids hardcoding schema names; works for any client |
| docker-compose.env gitignored; docker-compose.env.example committed | Secrets never in git; example shows all required variables |

### Deviations from Blueprint
| Deviation | Reason |
|-----------|--------|
| corrections table schema differs from Phase 0 template | Phase 0 had structured field/original/corrected; Phase 5 chatbot sends raw messages — simpler schema is correct for the use case |
| `openai` npm package added to project | Fine-tuning script requires OpenAI Files + FineTuning API directly; Vercel AI SDK does not expose these |

### Open Items (deferred)
- Activate fine-tuned model in MODEL_ROUTES — ask user after fine-tuning completes
- Wire `ChatbotPanel` schemaName from WorkflowPanel (currently defaults to "default") — ask user
- XBRL XML full generation for ACRA BizFile+ (future)
- Financial model history tab (explicitly deferred — not in Phase 3 scope)
- Charts/graphs in model dashboard (explicitly deferred — tables only)
- FWL, YTD OW, payslip zip, CPF CSV stripping — carried from Phase 4


---

## Phase 6 — Polish & Deploy
**Status:** Complete
**Date completed:** 2026-04-04

### Files Built
| File | Purpose |
|------|---------|
| `app/auth/register/page.tsx` | User registration form |
| `app/auth/login/page.tsx` | Login form — NextAuth signIn() |
| `app/auth/error/page.tsx` | NextAuth error page |
| `app/api/auth/register/route.ts` | POST registration — bcrypt hash + Supabase insert |
| `app/clients/page.tsx` | Client management table + Add New Client form |
| `components/AddClientForm.tsx` | New client form component |
| `app/api/clients/route.ts` | GET list + POST create (schema creation via SQL) |
| `app/api/clients/[id]/route.ts` | GET detail (incl. entity_id + fiscal_year_id) + PUT update |
| `app/history/page.tsx` | History tabs: FS | Models | Payroll — read-only |
| `app/api/history/route.ts` | GET history items by type |
| `app/api/history/pdf/route.ts` | GET stored PDF by output ID |
| `app/help/page.tsx` | Static help/documentation page |
| `app/api/admin/costs/route.ts` | GET 30-day token usage + estimated cost (admin only) |
| `lib/validateEnv.ts` | Startup env var validation — throws clearly if missing |
| `lib/schemaAccess.ts` | verifySchemaAccess() — schema isolation guard |
| `lib/pgvectorClient.ts` | pgvector upsertEmbedding() + queryEmbeddings() |
| `lib/vectorStore.ts` | Environment-aware router: dev=ChromaDB, prod=pgvector |
| `scripts/migrateChromaToPgvector.ts` | One-time ChromaDB → pgvector migration |
| `vercel.json` | Vercel function maxDuration config |

### Files Modified
| File | Change |
|------|--------|
| `auth.ts` | Wired credentials provider to Supabase users table + bcrypt verify; JWT callbacks store id + role |
| `proxy.ts` | Auth enforcement: redirects unauthenticated users to /auth/login; public: /auth/*, /api/auth/* |
| `app/layout.tsx` | Added SessionProvider; calls validateEnv() on startup |
| `app/page.tsx` | Header shows session user name + Sign Out button |
| `components/BottomNav.tsx` | Added Help link |
| `components/WorkflowPanel.tsx` | Client selector dropdown; removed hardcoded entity_id/fiscal_year_id |
| `app/api/corrections/route.ts` | verifySchemaAccess() added to GET and PATCH |
| `app/api/chat/route.ts` | verifySchemaAccess(); switched to vectorStore.ts; Langfuse error logging |
| `app/api/generate-fs/route.ts` | Langfuse ERROR trace in catch block |
| `supabase/schema.sql` | Added password_hash to users; added client_schemas table; added pgvector tables |

### Packages Installed
| Package | Purpose |
|---------|---------|
| `bcryptjs` | Password hashing for registration + login |
| `@types/bcryptjs` | TypeScript types |

### Decisions
| Decision | Reason |
|----------|--------|
| client_schemas registry table in public schema | Needed by WorkflowPanel to look up entity_id/fiscal_year_id without hardcoding; also serves as the schema access allowlist |
| verifySchemaAccess() caches verified schemas in memory | One DB round-trip per schema per server process; safe because schemas are registered once and never deleted |
| vectorStore.ts uses dynamic imports | Avoids bundling chromadb in production build where it's not used |
| proxy.ts uses manual session check (not exported auth) | Required to call async auth() and redirect — the simple `export { auth as proxy }` pattern used in Phase 0 cannot conditionally redirect |
| Admin role check in /api/admin/costs | Cost data is sensitive; requires role="admin" in session |
| Langfuse error logging uses trace.update (not level) | trace.update() does not accept level field — error context stored in output object instead |
| pgvector upsert conflict key: (source_file, chunk_index) | Natural dedup key — re-ingesting a file replaces existing chunks without creating duplicates |

### Deviations from Blueprint
| Deviation | Reason |
|-----------|--------|
| exec_sql RPC not used for schema creation | Supabase does not expose a generic exec_sql RPC by default; the buildSchemaSQL function is prepared but requires a custom RPC to be created in Supabase. Documented in the clients API comment. |
| middleware.ts still present (unused) | proxy.ts is the active file per Next.js 16.2 convention; middleware.ts is a remnant from Phase 0 and can be deleted after confirming proxy.ts works |

### Open Items
- Run `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';` in Supabase SQL editor for existing deployments
- Create `public.client_schemas` table in Supabase (SQL in schema.sql)
- Create the `match_knowledge_embeddings` RPC in Supabase before going live (SQL in lib/pgvectorClient.ts comments)
- Create custom `exec_sql` RPC in Supabase for the clients POST route schema creation to work
- Run `scripts/migrateChromaToPgvector.ts` before deploying to production
- Sign up at cloud.langfuse.com and add LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST=https://cloud.langfuse.com to Vercel env vars
- Add all required env vars to Vercel dashboard before running `vercel --prod`

---

## Phase 7 — Corporate Tax Computation
**Status:** Complete
**Date completed:** 2026-04-05

### Skill Created
| File | Purpose |
|------|---------|
| `skills/sg-corporate-tax/SKILL.md` | SG corporate tax rules — CIT rate, YA 2026 rebate, exemption tiers, form types, ECI, deadlines |

### Files Built
| File | Purpose |
|------|---------|
| `lib/taxEngine.ts` | Pure-arithmetic corporate tax engine — `computeTax()`, `applyTaxExemption()`, `computeCITRebate()`, `determineFormType()` |
| `lib/taxPdfGenerator.ts` | pdfkit tax computation schedule PDF — `generateTaxComputationPDF()` |
| `app/api/tax/compute/route.ts` | POST `/api/tax/compute` — runs engine, saves to DB, returns result |
| `app/api/tax/pdf/route.ts` | POST `/api/tax/pdf` — generates and downloads tax computation PDF |
| `components/TaxWorkflow.tsx` | 3-step corporate tax UI — setup → adjustments → results |

### Files Modified
| File | Change |
|------|--------|
| `lib/schemas.ts` | Added `TaxAdjustmentSchema`, `TaxComputationInputSchema`, `TaxComputationResultSchema` (Phase 7 section at end) |
| `supabase/schema.sql` | Added `tax_computations` table to per-client schema template + techsoft_pte_ltd test SQL comment block |
| `components/WorkflowPanel.tsx` | Added `corporate_tax` to `Task` type; imported `TaxWorkflow`; added radio button; mounted `TaxWorkflow` block |
| `.gitignore` | Added `skills/sg-corporate-tax/SKILL.md` to custom skills section |
| `CLAUDE.md` | Phase 7 → Complete; project structure updated; What NOT to do updated |

### Decisions
| Decision | Reason |
|----------|--------|
| No AI in tax engine | Corporate tax is deterministic law — AI would introduce compliance risk and rounding errors |
| bignumber.js throughout | Consistent with Phases 2–4; avoids float drift on cent-level tax amounts |
| CIT Rebate cash grant takes priority over rebate in cap calculation | Cash grant is a flat payment; rebate is reduced first if total benefit would exceed $30,000 cap |
| `fiscal_year_end` injected at API boundary (not in Zod schema) | Engine needs FYE to compute YA and ECI deadline; Zod schema stays clean with only computation inputs |
| New Start-Up vs Partial as a boolean flag (`is_new_startup`) | Simple toggle; avoids more complex eligibility checking that would require company incorporation date |
| Tax adjustments pre-populated with 3 common SG items | UX: most SG companies have private car expenses and dividends; reduces setup time |
| `latest-fs` route returns metadata only (not structured_data) | Avoids transmitting large JSONB objects for a setup hint; user enters profit/revenue manually |
| `TaxWorkflow` fetches FS metadata on mount for display hint | Shows user if FS is available; gracefully falls back to manual entry |
| PDF uses same layout constants as `pdfGenerator.ts` | Consistent document appearance; reuses established PDF design |
| `tax_computations` table stores amounts as `NUMERIC(18,2)` | Matches bignumber.js 2 d.p. output; avoids TEXT-to-float drift in DB queries |

### Deviations from Blueprint
| Deviation | Reason |
|-----------|--------|
| `TaxWorkflow` does not auto-populate accounting_profit and revenue from FS structured_data | `/api/model/latest-fs` route returns metadata only (not full structured_data); fetching and parsing the full FS output would require a new API endpoint. User enters values manually with a hint that FS data is available. Deferred to ask user if auto-populate is desired. |

### Open Items (deferred)
- Capital allowance auto-calculation (Section 19/19A) — ask user before building
- GST computation — ask user before building
- Group relief — ask user before building
- Auto-populate accounting_profit/revenue from saved FS structured_data — ask user first
- Instalment payment plan computation — ask user before building

---

## RAG Evaluation Pipeline
**Status:** Complete
**Location:** `ml/` folder — Python only, separate from Next.js app

### Files Built
| File | Purpose |
|------|---------|
| `ml/evaluate_rag.py` | Main RAGAS evaluation script — queries ChromaDB, generates answers, measures 4 metrics |
| `ml/test_questions.json` | 10 SG accounting test questions with expected answers (SFRS, CPF, IRAS, ACRA) |
| `ml/requirements.txt` | Python dependencies: chromadb, openai, ragas, python-dotenv, pandas |
| `ml/.env.example` | Environment template: OPENAI_API_KEY, CHROMA_HOST, CHROMA_PORT, CHROMA_COLLECTION |
| `ml/README.md` | Setup and usage instructions |

### Metrics Measured
| Metric | Description |
|--------|-------------|
| `faithfulness` | Is the answer grounded in retrieved context? (1.0 = no hallucination) |
| `answer_relevancy` | Does the answer address the question? |
| `context_precision` | Are retrieved chunks relevant (signal over noise)? |
| `context_recall` | Does context contain everything needed to answer? |

### How to Run
```bash
cd ml
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in OPENAI_API_KEY in ml/.env
python3 evaluate_rag.py
```

### Prerequisites Before Running
1. ChromaDB must be running: `docker compose --env-file docker-compose.env up -d`
2. Documents must be ingested: `npx tsx scripts/ingest.ts` (from project root)

### Decisions
| Decision | Reason |
|----------|--------|
| Separate Python pipeline (not TypeScript) | RAGAS requires a Python ecosystem (HuggingFace datasets, LLM judges); no Python in Next.js |
| Uses `text-embedding-3-small` for queries | Must match the embedding model used in `lib/ingest.ts` — different models = incompatible embedding spaces |
| Uses `gpt-4.1-mini` for answer generation | Mirrors the chatbot question path in `app/api/chat/route.ts` |
| TOP_K=5 chunks per question | Slightly higher than chatbot (4) to give RAGAS more context for recall measurement |
| Results saved to CSV (gitignored) | Generated data, not source code — excluded from version control |

---

## Production Deployment
**Status:** Live
**Date:** 2026-04-05
**URL:** https://finagent-sg.vercel.app

### Details
- Platform: Vercel (Washington D.C., iad1)
- Build: Next.js 16.2.1 with Turbopack
- Vector store: pgvector (Supabase) — ChromaDB is local dev only
- LLM observability: Langfuse Cloud (cloud.langfuse.com)
- Auth: NextAuth.js, public registration disabled — admin creates accounts

### Build Fixes Applied
| Issue | Fix |
|-------|-----|
| `@chroma-core/default-embed` `.d.cts` Turbopack module format conflict | `turbopack.ignoreIssue` in `next.config.ts` — package is external (never bundled), false-alarm error suppressed |
| `useSearchParams()` missing Suspense boundary at `/auth/error` | Split into `page.tsx` (Suspense wrapper) + `AuthErrorContent.tsx` (client component) |
| `useSearchParams()` missing Suspense boundary at `/corrections` | Split into `page.tsx` (Suspense wrapper) + `CorrectionsContent.tsx` (client component) |

---

## Context7 MCP
**Status:** Configured
**Date:** 2026-04-05

### Configuration
- **File:** `.claude/mcp.json` (gitignored — installed per-machine via Claude Code settings)
- **Server:** `@upstash/context7-mcp` — fetches live, version-accurate library documentation on demand

### Purpose
Provides Claude Code with up-to-date documentation for project dependencies so generated code uses current APIs, not stale training data. Activates automatically on every Claude Code session.

### Libraries Covered
| Library | Why It Matters |
|---------|---------------|
| Next.js 15 | App Router patterns, server components, route handlers |
| Vercel AI SDK 6 | `generateText`, `streamText`, tool use, SSE streaming |
| Supabase JS | Schema-per-client queries, RLS, storage |
| exceljs | Workbook/sheet API for trial balance parsing and Excel export |
| pdfkit | PDF layout, font handling, page layout constants |

### How to Activate on a New Machine
1. Open Claude Code settings → MCP Servers
2. Add server: `npx -y @upstash/context7-mcp`
3. Or copy `.claude/mcp.json` from another machine (not committed to git)
