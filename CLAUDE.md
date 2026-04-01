# FinAgent-SG — Project Context for Claude Code

**Project:** FinAgent-SG — agentic AI accountant for Singapore private limited companies
**Blueprint version:** 2.0

---

## Strict Scope Rule

Before adding any feature, function, or file not explicitly requested by the user, **stop and ask first**.
Do not add anything anticipatory or "nice to have". If in doubt, ask.

---

## Current Build Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 | Foundation — scaffolding, schema, Zod, UI shell | **Complete** |
| Phase 1 | RAG Pipeline — ingestion, query, chatbot upload | **Complete** |
| Phase 2 | FS Preparation Agent — Excel parsing, AI + RAG, PDF output | **Complete** |
| Phase 3 | Financial Model Agent — projections, scenarios | **Complete** |
| Phase 4 | Payroll & CPF Agent | **Complete** |
| Phase 5 | Continuous Improvement — fine-tuning, Langfuse | **Next** |
| Phase 6 | Polish & Deploy | Not started |

**Do not build ahead of the current phase without explicit instruction.**

---

## Tech Stack (locked — do not deviate)

- **Next.js 15**, TypeScript, App Router
- **Vercel AI SDK 6** + OpenAI provider (`@ai-sdk/openai`)
- **Supabase** (PostgreSQL) — structured data storage
- **ChromaDB** — local vector store, Docker on port 8000, **v2 API**
- **NextAuth.js** — email/password only (no OAuth, no magic link)
- **Tailwind CSS** + shadcn/ui — styling and components
- **Zod** — all data validation and schema definitions
- **bignumber.js** — all financial arithmetic (installed, used from Phase 2)
- **exceljs** — Excel parsing (replaces SheetJS/xlsx; installed, used from Phase 2)
- **pdfkit** — PDF generation (installed in Phase 2)
- **@trigger.dev/sdk** v4 — background job processing (installed in Phase 2; use v3 API: `import { task } from "@trigger.dev/sdk/v3"`)

---

## Key Conventions

- **Client schema naming:** company name slug — e.g. `"ABC Pte Ltd"` → `"abc_pte_ltd"`. Use `generateSchemaName()` from `lib/schemaUtils.ts`.
- **Financial arithmetic:** always use `bignumber.js` — never native JS math for any financial calculation.
- **AI vs Tools:** the LLM decides structure and logic; TypeScript tool functions do the actual computation. Never let the LLM compute numbers directly.
- **Comments:** every file must include a comment block at the top explaining what it does and what it will do when fully built.
- **TypeScript only** — no Python anywhere in the Next.js project.
- **SSE streaming:** use Web Streams API (ReadableStream) in App Router routes — not Node.js `res.write()`.
- **Buffer → Response:** convert `Buffer` to `new Uint8Array(buffer)` before passing to `new Response()` in App Router.
- **PDF generation:** uses pdfkit — files are generated as `Promise<Buffer>` and converted to `Uint8Array` for the response.
- **GPT model choice:** GPT-4.1-mini for cost-efficient classification; GPT-4.1 for accuracy-critical FS generation.

---

## What NOT to do

- No fine-tuning setup until Phase 5
- No Langfuse observability until Phase 5
- No GST, corporate tax, or consolidation (future features)
- **Do not modify Phase 0 or Phase 1 files unless strictly necessary — ask the user first**

---

## Project Structure (Phase 4 complete)

```
finagent-sg/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── globals.css
│   └── api/
│       ├── ingest/route.ts                    # Phase 1: RAG ingestion endpoint
│       ├── generate-fs/route.ts               # Phase 2: SSE pipeline + Supabase save
│       ├── generate-pdf/route.ts              # Phase 2: PDF download endpoint
│       ├── model/
│       │   ├── latest-fs/route.ts             # Phase 3: GET latest FS output for a schema
│       │   ├── suggest-assumptions/route.ts   # Phase 3: AI + RAG assumption suggester
│       │   ├── run/route.ts                   # Phase 3: SSE — project base/best/worst scenarios
│       │   ├── save/route.ts                  # Phase 3: save financial model to DB
│       │   ├── export-excel/route.ts          # Phase 3: export 8-sheet Excel workbook
│       │   └── upload-actuals/route.ts        # Phase 3: parse actuals + run BVA comparison
│       └── payroll/
│           ├── run/route.ts                   # Phase 4: POST run payroll + PATCH finalise
│           ├── payslip/route.ts               # Phase 4: POST generate individual payslip PDF
│           ├── export-cpf/route.ts            # Phase 4: POST CPF e-Submit CSV download
│           ├── journal/route.ts               # Phase 4: POST payroll journal entries JSON
│           ├── employees/route.ts             # Phase 4: GET list + POST create employee
│           └── employees/[id]/route.ts        # Phase 4: PUT update + DELETE employee
├── components/
│   ├── WorkflowPanel.tsx           # Phase 2+3+4: task selector, FS + Model + Payroll workflows
│   ├── FSPreview.tsx               # Phase 3: in-browser FS preview modal
│   ├── ModelWorkflow.tsx           # Phase 3: 4-step financial model UI
│   ├── ProjectionTable.tsx         # Phase 3: P&L / Balance Sheet projection table
│   ├── VarianceTable.tsx           # Phase 3: Budget-vs-actual variance table
│   ├── PayrollWorkflow.tsx         # Phase 4: 3-step payroll UI (employees → run → download)
│   ├── ChatbotPanel.tsx            # Phase 1: training & feedback chatbot
│   └── BottomNav.tsx
├── lib/
│   ├── chromaClient.ts             # Phase 0: ChromaDB client
│   ├── schemaUtils.ts              # Phase 0: generateSchemaName()
│   ├── schemas.ts                  # Phase 0+1+2+3+4: all Zod schemas
│   ├── ragQuery.ts                 # Phase 1: RAG query pipeline
│   ├── ingest.ts                   # Phase 1: document ingestion
│   ├── excelParser.ts              # Phase 2: trial balance Excel parser
│   ├── accountClassifier.ts        # Phase 2: AI + RAG SFRS classifier
│   ├── exemptionChecker.ts         # Phase 2: Singapore audit exemption logic
│   ├── calculationEngine.ts        # Phase 2+3: BigNumber arithmetic
│   ├── fsGenerator.ts              # Phase 2: AI FS assembly
│   ├── pdfGenerator.ts             # Phase 2: pdfkit FS PDF generator
│   ├── supabaseClient.ts           # Phase 3: singleton service-role Supabase client
│   ├── outputStorage.ts            # Phase 3: saveGeneratedFS(), getLatestFS()
│   ├── modelStorage.ts             # Phase 3: saveFinancialModel(), getActiveModel()
│   ├── projectionEngine.ts         # Phase 3: projectFinancials(), validateProjection()
│   ├── scenarioAnalysis.ts         # Phase 3: generateScenarios(), runAllScenarios()
│   ├── assumptionSuggester.ts      # Phase 3: suggestAssumptions() via GPT-4.1-mini + RAG
│   ├── budgetVsActual.ts           # Phase 3: compareBudgetVsActual(), summarizeBVA()
│   ├── modelExcelExport.ts         # Phase 3: generateModelExcel() — 8-sheet ExcelJS workbook
│   ├── cpfEngine.ts                # Phase 4: pure-arithmetic CPF engine (no AI)
│   ├── payslipGenerator.ts         # Phase 4: pdfkit MOM-compliant payslip PDF
│   ├── cpfSubmissionExport.ts      # Phase 4: CPF e-Submit CSV generator
│   ├── payrollJournal.ts           # Phase 4: double-entry payroll journal entries
│   └── utils.ts
├── trigger/
│   └── fsGenerationJob.ts          # Phase 2: Trigger.dev background job definition
├── scripts/
│   ├── ingest.ts                   # Phase 1: bulk RAG ingestion CLI
│   ├── testRag.ts                  # Phase 1: RAG test script
│   └── createSampleTrialBalance.ts # Phase 2: creates docs/samples/sample_trial_balance.xlsx
├── skills/
│   ├── sg-accounting-standards/SKILL.md  # Phase 2: SG accounting rules
│   └── sg-payroll-cpf/SKILL.md           # Phase 4: CPF rates + payroll rules (1 Jan 2026)
├── .agents/skills/                 # Vercel skills (installed via npx skills add)
├── supabase/schema.sql
├── docs/
│   ├── knowledge/                  # SFRS PDFs for RAG ingestion
│   └── samples/
│       └── sample_trial_balance.xlsx  # Phase 2: 41-account sample (balanced, SGD 1,207,800)
├── auth.ts
├── middleware.ts
├── proxy.ts
└── .env.local
```

---

## Known Issues / Deferred Items

### Deferred items
- `middleware.ts` deprecation warning (Next.js 16.2 renamed to proxy) — not fixed, ask user first.
- Trigger.dev job (`trigger/fsGenerationJob.ts`) requires `TRIGGER_SECRET_KEY` in `.env.local` to connect to Trigger.dev cloud. The SSE route (`/api/generate-fs`) runs the same pipeline inline for dev/demo.
- PDF `formatAmount` uses native `toLocaleString` for display-only formatting (not financial arithmetic) — this is acceptable since bignumber.js handles all calculation.
- XBRL output is JSON tags only — full XBRL XML generation for ACRA BizFile+ is a future feature, ask user before building.

### Deferred / Phase 5+
- Langfuse observability (Phase 5)
- XBRL XML full generation for ACRA BizFile+ (future)
- Financial model history tab (explicitly deferred — not in Phase 3 scope)
- Charts/graphs in model dashboard (explicitly deferred — tables only in Phase 3)
- FWL (Foreign Worker Levy) computation — flagged for manual input; rates vary by sector/DRQ
- Payroll YTD OW tracking for precise AW ceiling per employee (Phase 4 uses ytd_ow=0 default)
- Payslip download uses sequential browser downloads (one per employee); consider zip in future
- CPF e-Submit comment rows may need stripping before portal upload (portal-dependent)
