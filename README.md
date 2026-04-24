# FinAgent-SG

**Production:** https://finagent-sg.vercel.app

FinAgent-SG is an AI-powered accounting assistant for Singapore private limited companies. It automates the preparation of SFRS-compliant financial statements, financial projections, payroll processing, and corporate tax computation — reducing manual effort and the risk of errors. Built for accountants and finance professionals who manage Singapore-incorporated entities.

---

## Use Cases

- **Financial Statement Preparation** — Upload a trial balance (Excel or CSV) and receive a complete set of SFRS-compliant financial statements as a downloadable PDF.
- **Receipt Segregation** — Upload receipts, invoices, or bank statement exports (PDF, image, or CSV). GPT-4.1 Vision extracts line items automatically; items can also be entered manually. Review and correct the editable table, then generate a trial balance and export it as Excel.
- **Financial Model Builder** — Generate multi-year financial projections with base, best-case, and worst-case scenarios, and compare them against actual results.
- **Payroll & CPF Processing** — Run monthly payroll, compute CPF contributions, generate MOM-compliant payslips, and export the CPF e-Submit file.
- **Corporate Tax Computation** — Automatically determine the correct IRAS form type (C-S Lite, C-S, or Form C), apply the correct exemption scheme, compute chargeable income after adjustments, and calculate net tax payable including the YA 2026 CIT Rebate. Download the tax computation schedule as a PDF.

---

## How It Works

1. Sign in with your account (public registration is disabled — contact your administrator to be added).
2. Upload the client's trial balance as an Excel or CSV file, or use the Receipt Segregation workflow to build a trial balance from receipts and invoices.
3. The AI reviews the accounts, applies Singapore Financial Reporting Standards, and generates a full set of financial statements.
4. Review the output in the browser and download the PDF.
5. If anything looks incorrect, submit a correction through the integrated chatbot — corrections are immediately added to the knowledge base.
6. Run the corporate tax computation workflow to compute and document the client's tax position.

---

## Tech Stack

| Tool | Purpose |
|------|---------|
| Next.js 15 | Full-stack web framework (App Router) |
| Vercel AI SDK 6 | Streaming AI responses and tool integration |
| OpenAI | Language model for financial statement generation and analysis |
| Supabase | Multi-tenant PostgreSQL database and authentication backend |
| ChromaDB | Local vector store for RAG during development |
| pgvector | Production vector store hosted within Supabase |
| Langfuse | LLM observability, tracing, and cost tracking |
| Trigger.dev | Background job processing for long-running tasks |
| NextAuth.js | Email and password authentication |
| Zod | Runtime data validation across all API boundaries |
| bignumber.js | Precise financial arithmetic without floating-point errors |
| exceljs | Excel file parsing and workbook export |
| pdfkit | PDF generation for financial statements and payslips |
| Docker | Local infrastructure for ChromaDB and Langfuse |
| RAGAS | RAG quality evaluation — Python pipeline in ml/ folder, run manually |
| Context7 MCP | Live library documentation for Claude Code — configured in .claude/mcp.json |

---

## Prerequisites

- Node.js 18+
- Python 3.8+ (for RAG evaluation only)
- Docker Desktop
- A Supabase account
- An OpenAI account with API key

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the values:

```
OPENAI_API_KEY
NEXTAUTH_SECRET
NEXTAUTH_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CHROMA_URL
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
LANGFUSE_HOST
```

Copy `docker-compose.env.example` to `docker-compose.env` and fill in values for Langfuse (PostgreSQL password, auth secrets, admin email/password).

---

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in environment variables
cp .env.example .env.local
cp docker-compose.env.example docker-compose.env

# 3. Start Docker services (ChromaDB + Langfuse)
docker compose --env-file docker-compose.env up -d

# 4. Verify ChromaDB is running
curl http://localhost:8000/api/v2/version
# Expected: "1.0.0"

# 5. Run database schema in Supabase SQL editor
# Open supabase/schema.sql and run it in the Supabase dashboard
# Note: only the shared users table is created by the schema SQL.
# Per-client schemas are created automatically when you add a
# client through the app.
#
# If you have existing client schemas, also run the receipts table
# migration block at the bottom of supabase/schema.sql for each
# schema to enable the Receipt Segregation feature.

# 6. Ingest knowledge base documents into ChromaDB
npx tsx scripts/ingest.ts

# 7. Start the development server
npm run dev
# App runs at http://localhost:3000
```

Sign in at [http://localhost:3000/auth/login](http://localhost:3000/auth/login). User accounts are created by an admin directly in Supabase — public registration is disabled.

---

## Infrastructure Commands

### ChromaDB (vector store)

```bash
# Start ChromaDB
docker compose --env-file docker-compose.env up -d chromadb

# Check ChromaDB is running and see version
curl http://localhost:8000/api/v2/version

# Stop ChromaDB
docker compose --env-file docker-compose.env stop chromadb

# View ChromaDB logs
docker compose --env-file docker-compose.env logs chromadb
```

### Langfuse (LLM observability)

```bash
# Start Langfuse (includes its PostgreSQL database)
docker compose --env-file docker-compose.env up -d langfuse

# Open Langfuse dashboard
open http://localhost:3001
# Default credentials are set in docker-compose.env (LANGFUSE_INIT_USER_*)

# View Langfuse logs
docker compose --env-file docker-compose.env logs langfuse

# Start all Docker services at once
docker compose --env-file docker-compose.env up -d

# Stop all Docker services
docker compose --env-file docker-compose.env down
```

---

## Knowledge Base (RAG Ingestion)

Documents in `docs/knowledge/` (SFRS PDFs, IRAS guides, ACRA documentation) are chunked, embedded, and stored in ChromaDB. Re-run ingestion after adding new documents.

```bash
# Ingest all documents from docs/knowledge/ into ChromaDB
npx tsx scripts/ingest.ts

# Test RAG retrieval with 5 sample queries
npx tsx scripts/testRag.ts
```

---

## Government Document Monitoring

On every `npm run dev` startup, FinAgent-SG automatically fetches three monitored government sources (CPF Board, IRAS, ASC/ACRA), compares their SHA-256 hashes against the stored values in `scripts/ingest-sources.json`, and reports the result in the terminal. If a document has changed, it is re-ingested into ChromaDB and any new values for hardcoded constants (CPF rates, tax rates, SDL cap, etc.) are extracted and written to `scripts/pending-updates.json` as a diff.

The check re-runs every 24 hours of continuous uptime. App startup is never blocked — the check runs in the background.

To review and apply any detected constant changes:

```bash
npx tsx scripts/applyUpdates.ts
```

This opens an interactive CLI that shows each pending change (current value vs extracted value), asks for confirmation one change at a time, and patches the TypeScript source file directly. The app hot-reloads automatically after each confirmed write (Next.js dev mode).

Monitored sources:
- CPF Board — contribution rate tables
- IRAS — corporate income tax rate, rebates, and exemption schemes
- ASC/ACRA — Singapore Financial Reporting Standards

---

## RAG Quality Evaluation

Measures how well the AI retrieves relevant Singapore accounting knowledge from the knowledge base. Uses [RAGAS](https://docs.ragas.io/) to score faithfulness, answer relevancy, context precision, and context recall. Run after ingesting new documents or if AI output quality seems degraded.

```bash
# Set up the Python environment (first time only)
cd ml
python3 -m venv venv
source venv/bin/activate        # Mac/Linux
# venv\Scripts\activate         # Windows
pip install -r requirements.txt

# Copy and fill in your OpenAI key
cp .env.example .env
# Edit ml/.env and set OPENAI_API_KEY=sk-...

# Run the evaluation (ChromaDB must be running and documents ingested)
python3 evaluate_rag.py
```

Score guide: **0.8–1.0** Excellent · **0.6–0.8** Good · **0.4–0.6** Fair (add more docs) · **0.0–0.4** Poor. Results are saved to `ml/rag_evaluation_results.csv`. See [ml/README.md](ml/README.md) for full details.

---

## Fine-tuning

Once 50+ corrections have been reviewed and approved in `/corrections`, you can fine-tune the model to permanently improve its outputs.

```bash
# Export reviewed corrections to JSONL training format
npx tsx scripts/exportTrainingData.ts
# Output: docs/training/training_data.jsonl

# Upload JSONL to OpenAI and start a fine-tuning job
npx tsx scripts/runFineTuning.ts
# Prints the fine-tuning job ID — job takes 15–30 minutes

# After the job completes, copy the model ID printed in the output
# and paste it into MODEL_ROUTES.fine_tuned_model in lib/modelRouter.ts
```

See `docs/training/README.txt` for full instructions.

---

## Deployment

**Production URL:** https://finagent-sg.vercel.app

The app is deployed on Vercel. ChromaDB and Langfuse run locally during development; in production, ChromaDB is replaced by pgvector (hosted in Supabase).

```bash
# Migrate ChromaDB vectors to pgvector before deploying to production (one-time — already done)
npx tsx scripts/migrateChromaToPgvector.ts

# Deploy to Vercel
vercel --prod
```

**Required Vercel environment variables** — set these in the Vercel dashboard before deploying:

```
OPENAI_API_KEY
NEXTAUTH_SECRET
NEXTAUTH_URL                        # your production URL, e.g. https://finagent-sg.vercel.app
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ACCESS_TOKEN               # Supabase personal access token (for schema auto-exposure)
LANGFUSE_PUBLIC_KEY                 # from cloud.langfuse.com
LANGFUSE_SECRET_KEY
LANGFUSE_HOST                       # https://cloud.langfuse.com
```

---

## Project Structure

| Folder / File | Description |
|---------------|-------------|
| `app/` | Next.js pages and API routes |
| `app/receipts/` | Receipt Segregation page — upload, extract, manual entry, trial balance preview |
| `app/api/receipts/` | Receipt API routes — extract, save, export-excel |
| `components/` | Reusable UI components |
| `lib/` | Core business logic and utility modules |
| `lib/receiptToTrialBalance.ts` | Converts confirmed receipt items into a balanced TrialBalanceLine array |
| `scripts/` | CLI scripts for data ingestion and maintenance |
| `scripts/checkGovDocs.ts` | Fetches monitored government URLs, hashes content, extracts constant changes |
| `scripts/applyUpdates.ts` | Interactive diff-and-confirm CLI for applying extracted constant changes |
| `scripts/ingest-sources.json` | Monitored government source URLs and stored SHA-256 hashes |
| `instrumentation.ts` | Next.js startup hook — fires the government document watcher in the background |
| `supabase/` | Database schema SQL (includes `receipts` table migration) |
| `trigger/` | Background job definitions |
| `skills/` | Domain knowledge files for Singapore accounting and payroll rules |
| `docs/` | Reference documents, sample files, and training data |
| `ml/` | Python RAG evaluation pipeline (RAGAS) — run manually, separate from the Next.js app |
| `public/` | Static assets |

---

## License

This project is proprietary. All rights reserved.
